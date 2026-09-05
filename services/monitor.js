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
module.exports = (client) => {
    // 전역 일치율/히스토리 저장소 (server/api.js, commands/history.js와 공유)
    const zoneMatchData = {}; // 구역별 최신 일치율
    const zoneHistory = {};   // 구역별 최근 60개 히스토리

    // 마지막 알림 시간(서버·구역별, { "guildId-zoneName": timestamp }) — commands/resetcooldown.js와 공유
    const lastAlertTime = {};

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
                                roleId
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
    async function sendAlert(zone, percentage, imageBuffer, guildId, matchPixels, totalPixels, diffPixels, serverThreshold, channelId, roleId, suppressMention = false) {
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
