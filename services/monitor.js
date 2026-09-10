const axios = require('axios');
const sharp = require('sharp');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const fs = require('fs');
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');

const monitorZones = require('../config/zones');
const { Setting } = require('../db/models');
const { getZoneSetting } = require('../utils/helpers');

// services/monitor.js — 감시(checkZones)·알림(sendAlert)과 공유 상태(zoneMatchData/zoneHistory/lastAlertTime)를 모아둔 파일.
// index.js가 client로 한 번만 생성한 뒤, 이 "단 하나의" 참조를 여러 파일(server/api.js, commands/history.js 등)이 함께 씀

// --- 훼손자 식별(범인 추적) 관련 상수 ---
const WPLACE_API_BASE = 'https://backend.wplace.live';
const CULPRIT_SAMPLE_GRID = 3;      // 3x3 그리드로 나눠 칸당 1개씩 샘플링 (최대 9개 좌표)
const CULPRIT_DISPLAY_LIMIT = 5;    // 알림 임베드에 표시할 최대 계정 수
const CULPRIT_COLOR_THRESHOLD = 30; // RGBA 채널별 차이가 이 값을 넘으면 "달라진 픽셀"로 판단
const CULPRIT_FETCH_TIMEOUT = 5000; // /s0/pixel 요청 타임아웃(ms)

module.exports = (client) => {
    // 전역 일치율/히스토리 저장소 (server/api.js, commands/history.js와 공유)
    const zoneMatchData = {}; // 구역별 최신 일치율
    const zoneHistory = {};   // 구역별 최근 60개 히스토리

    // 마지막 알림 시간(서버·구역별, { "guildId-zoneName": timestamp }) — commands/resetcooldown.js와 공유
    const lastAlertTime = {};

    // zone에 tileX/tileY가 없는 과거 설정을 대비한 폴백 (tileUrl에서 파싱)
    function resolveTileCoords(zone) {
        if (Number.isInteger(zone.tileX) && Number.isInteger(zone.tileY)) {
            return { tileX: zone.tileX, tileY: zone.tileY };
        }
        const match = zone.tileUrl?.match(/tiles\/(\d+)\/(\d+)\.png/);
        return match ? { tileX: parseInt(match[1], 10), tileY: parseInt(match[2], 10) } : null;
    }

    // 원본/현재 이미지를 직접 픽셀 단위로 비교해 "달라진 픽셀"의 (localX, localY) 좌표 목록을 추출
    // (pixelmatch의 diff 출력 포맷에 의존하지 않는 독립적인 비교 — 정확한 개수가 아니라
    //  훼손자 식별을 위한 대표 좌표를 뽑는 용도이므로 매칭 알고리즘이 100% 동일할 필요는 없음)
    function extractDiffCoordinates(originalImg, currentImg, width, height) {
        const coords = [];
        const a = originalImg.data;
        const b = currentImg.data;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const dr = Math.abs(a[idx] - b[idx]);
                const dg = Math.abs(a[idx + 1] - b[idx + 1]);
                const db = Math.abs(a[idx + 2] - b[idx + 2]);
                const da = Math.abs(a[idx + 3] - b[idx + 3]);

                if (dr > CULPRIT_COLOR_THRESHOLD || dg > CULPRIT_COLOR_THRESHOLD ||
                    db > CULPRIT_COLOR_THRESHOLD || da > CULPRIT_COLOR_THRESHOLD) {
                    coords.push({ x, y });
                }
            }
        }
        return coords;
    }

    // diff 좌표 전체를 조회하지 않고, 그리드 칸마다 1개씩만 뽑아 공간적으로 고르게 분산된 대표 좌표를 추출
    function sampleDiffCoordinates(diffCoords, width, height) {
        if (diffCoords.length === 0) return [];

        const cellW = width / CULPRIT_SAMPLE_GRID;
        const cellH = height / CULPRIT_SAMPLE_GRID;
        const buckets = new Map();

        for (const coord of diffCoords) {
            const gx = Math.min(CULPRIT_SAMPLE_GRID - 1, Math.floor(coord.x / cellW));
            const gy = Math.min(CULPRIT_SAMPLE_GRID - 1, Math.floor(coord.y / cellH));
            const key = `${gx},${gy}`;
            if (!buckets.has(key)) {
                buckets.set(key, coord);
            }
        }
        return Array.from(buckets.values());
    }

    // 샘플 좌표들로 /s0/pixel 을 병렬 조회해 실제로 칠한 계정을 식별 (인증 불필요)
    // 실패한 개별 호출은 무시하고, 알림 전송 자체를 막지 않도록 예외를 여기서 흡수함
    async function identifyPainters(zone, sampledCoords) {
        const tileCoords = resolveTileCoords(zone);
        if (!tileCoords || sampledCoords.length === 0) {
            return { list: [], sampleCount: sampledCoords.length, matchedCount: 0 };
        }

        const results = await Promise.allSettled(
            sampledCoords.map(coord =>
                axios.get(`${WPLACE_API_BASE}/s0/pixel/${tileCoords.tileX}/${tileCoords.tileY}`, {
                    params: { x: zone.x + coord.x, y: zone.y + coord.y },
                    timeout: CULPRIT_FETCH_TIMEOUT
                })
            )
        );

        const painterMap = new Map();
        let matchedCount = 0;

        for (const result of results) {
            if (result.status !== 'fulfilled') continue;
            const paintedBy = result.value?.data?.paintedBy;
            if (!paintedBy || !paintedBy.id) continue; // id 0 = 미채색(투명)

            matchedCount++;
            if (painterMap.has(paintedBy.id)) {
                painterMap.get(paintedBy.id).count++;
            } else {
                painterMap.set(paintedBy.id, {
                    id: paintedBy.id,
                    name: paintedBy.name || '(이름 없음)',
                    allianceName: paintedBy.allianceName || '',
                    count: 1
                });
            }
        }

        const list = Array.from(painterMap.values()).sort((x, y) => y.count - x.count);
        return { list, sampleCount: sampledCoords.length, matchedCount };
    }

    // 핵심 감시 로직
    async function checkZones() {
        for (const zone of monitorZones) {
            try {
                if (!fs.existsSync(zone.originalPath)) {
                    console.warn(`⚠️ ${zone.name}의 원본 이미지가 없습니다: ${zone.originalPath}`);
                    continue;
                }

                // 현재 타일 다운로드 및 구간 추출
                const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
                const currentFlagBuffer = await sharp(Buffer.from(response.data))
                    .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                    .ensureAlpha()
                    .toBuffer();

                // 픽셀 비교
                const currentImg = PNG.sync.read(currentFlagBuffer);
                const originalImg = PNG.sync.read(fs.readFileSync(zone.originalPath));
                const { width, height } = originalImg;
                const diff = new PNG({ width, height });

                const numDiffPixels = pixelmatch(
                    originalImg.data, currentImg.data, diff.data, width, height,
                    { threshold: 0.1 }
                );

                const totalPixels = width * height;
                const matchPercentage = ((totalPixels - numDiffPixels) / totalPixels) * 100;

                // 일치율 데이터 저장
                zoneMatchData[zone.name] = {
                    percentage: matchPercentage,
                    timestamp: new Date().toISOString(),
                    totalPixels: totalPixels,
                    matchPixels: totalPixels - numDiffPixels,
                    diffPixels: numDiffPixels
                };

                // 히스토리 저장
                if (!zoneHistory[zone.name]) {
                    zoneHistory[zone.name] = [];
                }
                zoneHistory[zone.name].push({
                    percentage: matchPercentage,
                    timestamp: new Date().toISOString()
                });

                // 최대 60개만 유지
                if (zoneHistory[zone.name].length > 60) {
                    zoneHistory[zone.name].shift();
                }

                console.log(`[${zone.name}] 일치율: ${matchPercentage.toFixed(2)}%`);

                // 모든 활성화된 서버에 대해 각각의 임계값 체크
                const allSettings = await Setting.find({ enabled: true });

                // 훼손자 정보는 실제로 알림을 보내야 할 때 처음 한 번만 조회해서 이 사이클의 모든 서버에 재사용
                // (서버마다 threshold가 달라 알림 여부가 갈리므로, 무조건 매 zone마다 조회하지 않고 지연 계산함)
                let culpritInfo = null;

                for (const setting of allSettings) {
                    // 구역별 설정 가져오기
                    const channelId = getZoneSetting(setting, zone.name, 'channelId');
                    const roleId = getZoneSetting(setting, zone.name, 'roleId');
                    const threshold = getZoneSetting(setting, zone.name, 'threshold') || 90;

                    // 채널이 설정되지 않은 경우 스킵
                    if (!channelId) {
                        continue;
                    }

                    // 구역별 활성화 상태 확인
                    const zoneEnabled = setting.zones?.has(zone.name)
                        ? (setting.zones.get(zone.name).enabled !== false)
                        : true;

                    if (!zoneEnabled) {
                        continue;
                    }

                    // 임계값 미만일 경우에만 알림
                    if (matchPercentage < threshold) {
                        const now = Date.now();
                        const alertKey = `${setting.guildId}-${zone.name}`;
                        const lastTime = lastAlertTime[alertKey] || 0;

                        // 쿨다운 체크
                        if (now - lastTime > setting.cooldownTime) {
                            const matchPixels = totalPixels - numDiffPixels;

                            // 이 사이클에서 아직 훼손자 조회를 안 했다면 지금 1회만 수행 (실패해도 알림은 계속 진행)
                            if (culpritInfo === null) {
                                if (numDiffPixels > 0) {
                                    try {
                                        const diffCoords = extractDiffCoordinates(originalImg, currentImg, width, height);
                                        const sampledCoords = sampleDiffCoordinates(diffCoords, width, height);
                                        culpritInfo = await identifyPainters(zone, sampledCoords);
                                    } catch (culpritError) {
                                        console.error(`⚠️ ${zone.name} 훼손자 조회 실패:`, culpritError.message);
                                        culpritInfo = { list: [], sampleCount: 0, matchedCount: 0 };
                                    }
                                } else {
                                    culpritInfo = { list: [], sampleCount: 0, matchedCount: 0 };
                                }
                            }

                            await sendAlert(
                                zone,
                                matchPercentage,
                                currentFlagBuffer,
                                setting.guildId,
                                matchPixels,
                                totalPixels,
                                numDiffPixels,
                                threshold,
                                channelId,
                                roleId,
                                false,
                                culpritInfo
                            );
                            lastAlertTime[alertKey] = now;
                            console.log(`✅ [${zone.name}] 서버 ${setting.guildId}에 알림 전송 완료 (임계값: ${threshold}%)`);
                        } else {
                            const remaining = Math.ceil((setting.cooldownTime - (now - lastTime)) / 1000 / 60);
                            console.log(`⏳ [${zone.name}] 서버 ${setting.guildId} 쿨다운 중 (${remaining}분 남음)`);
                        }
                    }
                }

            } catch (error) {
                console.error(`❌ ${zone.name} 감시 오류:`, error.message);
            }
        }
    }

    // 알림 전송 함수
    // culpritInfo: identifyPainters()의 반환값({ list, sampleCount, matchedCount }). 없으면(null/undefined) 필드 생략
    async function sendAlert(zone, percentage, imageBuffer, guildId, matchPixels, totalPixels, diffPixels, serverThreshold, channelId, roleId, suppressMention = false, culpritInfo = null) {
        try {
            // channelId와 roleId를 인자로 받음 (구역별 설정 반영)
            if (!channelId) return;

            const channel = await client.channels.fetch(channelId);
            if (!channel) return;

            const attachment = new AttachmentBuilder(imageBuffer, { name: 'alert.png' });
            const embed = new EmbedBuilder()
                .setTitle(`🚨 태극기 훼손 감지: ${zone.name}`)
                .setURL(zone.wplaceUrl)
                .setDescription(
                    `${roleId ? `<@&${roleId}>` : '@everyone'} 즉각 대응이 필요합니다!\n` +
                    `현재 일치율: **${percentage.toFixed(2)}%** (기준: ${serverThreshold}%)`
                )
                .addFields(
                    { name: '픽셀 정보', value: `일치: ${matchPixels.toLocaleString()}/${totalPixels.toLocaleString()}\n불일치: ${diffPixels.toLocaleString()}개`, inline: false }
                )
                .setColor(0xFF0000)
                .setImage('attachment://alert.png')
                .setTimestamp();

            // 훼손자 정보가 있으면(샘플 조회로 실제 계정이 1명 이상 확인된 경우) 필드 추가
            if (culpritInfo && culpritInfo.list.length > 0) {
                const topCulprits = culpritInfo.list.slice(0, CULPRIT_DISPLAY_LIMIT);
                const culpritText = topCulprits
                    .map(c => `${c.name}${c.allianceName ? ` (${c.allianceName})` : ''} - ${c.count}곳`)
                    .join('\n');
                const moreCount = culpritInfo.list.length - topCulprits.length;

                embed.addFields({
                    name: `🔍 불일치 확인된 계정 (오탐 가능, 그리드 ${culpritInfo.sampleCount}곳 중 ${culpritInfo.matchedCount}곳 매치)`,
                    value: culpritText + (moreCount > 0 ? `\n...외 ${moreCount}명` : ''),
                    inline: false
                });
            }

            // suppressMention이 true면 멘션 없이, false면 기존 로직 사용
            const mentionContent = suppressMention
                ? null
                : (roleId ? `<@&${roleId}>` : '@everyone');

            // content가 null이면 전송하지 않음
            const messagePayload = {
                embeds: [embed],
                files: [attachment]
            };

            if (mentionContent) {
                messagePayload.content = mentionContent;
            }

            await channel.send(messagePayload);
        } catch (error) {
            console.error(`❌ 알림 전송 오류 (서버: ${guildId}):`, error.message);
        }
    }

    return {
        checkZones,
        sendAlert,
        zoneMatchData,
        zoneHistory,
        lastAlertTime
    };
};
