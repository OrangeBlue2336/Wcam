const env = require('./config/env');
const {
    MAX_RECORD_DURATION_MS,
    CAPTURE_INTERVAL_MS,
    API_SECRET_KEY,
    MONGODB_URI,
    BOT_TOKEN,
    KOYEB_URL,
    DEVELOPER_ID,
    PORT
} = env;

const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const sharp = require('sharp');
sharp.cache(false);
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const { PNG } = require('pngjs');
const fs = require('fs');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const path = require('path');
const { registerFont, createCanvas, loadImage } = require('canvas');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { Setting, Whitelist, RecordSession, RecordFrame } = require('./db/models');

const chartJSNodeCanvas = new ChartJSNodeCanvas({ 
    width: 1600, 
    height: 800,
    chartCallback: (ChartJS) => {
        ChartJS.defaults.font.family = 'GyeonggiTitle';
        ChartJS.defaults.font.size = 16;
    }
});
const fontPath = path.join(__dirname, 'fonts', '경기천년제목_M.ttf');
if (require('fs').existsSync(fontPath)) {
    registerFont(fontPath, { 
        family: 'GyeonggiTitle',
        weight: 'normal',
        style: 'normal'
    });
    console.log('✅ 폰트 로드 완료:', fontPath);
} else {
    console.warn('⚠️ 폰트 파일을 찾을 수 없습니다:', fontPath);
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 처리되지 않은 거부(Unhandled Rejection):', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ 잡히지 않은 예외(Uncaught Exception):', error);
});

// ========================================
// 2. MongoDB 연결 및 스키마 정의
// ========================================
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB 연결 성공!'))
    .catch(err => console.error('❌ MongoDB 연결 실패:', err));

// 마지막 알림 시간을 메모리에 저장 (서버별, 구역별)
const lastAlertTime = {}; // 형식: { "guildId-zoneName": timestamp }

// ========================================
// 3. Express 웹서버 (Keep-alive용)
// ========================================
const app = express();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 서버가 포트 ${PORT}에서 실행 중입니다`);
    console.log(`📡 Public URL: ${KOYEB_URL}`);
});

// 구역별 실시간 데이터 API에서 사용하는 전역 상태
// (실제 라우트는 client, monitorZones가 만들어진 뒤 server/api.js에서 등록됩니다)
const zoneMatchData = {}; // 전역 변수로 일치율 저장
const zoneHistory = {}; // 구역별 히스토리 저장

app.use(express.static('public')); // public 폴더에 HTML 파일 넣기

setInterval(() => {
    if (KOYEB_URL) {
        axios.get(`${KOYEB_URL}/api/status`, {
            headers: { 'x-api-key': API_SECRET_KEY }
        }).catch(err => console.log('헬스 체크:', err.message));
    }
}, 1000 * 60 * 10);

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM 신호 수신, 종료 준비 중...');
    
    // Discord 봇 종료
    client.destroy();
    
    // MongoDB 연결 종료
    await mongoose.connection.close();
    
    console.log('✅ 정상 종료 완료');
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 SIGINT 신호 수신, 종료 준비 중...');
    
    client.destroy();
    await mongoose.connection.close();
    
    console.log('✅ 정상 종료 완료');
    process.exit(0);
});

// ========================================
// 4. 디스코드 봇 클라이언트 생성
// ========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.setMaxListeners(15);

// ========================================
// 5. 감시 구역 설정
// ========================================
const monitorZones = require('./config/zones');

// Express API 라우트 등록 (zoneMatchData, zoneHistory, monitorZones, client 준비된 뒤 연결)
require('./server/api')(app, { zoneMatchData, zoneHistory, monitorZones, client });

// ========================================
// 6. 유틸리티 함수
// ========================================
const {
    generateSessionId,
    parseDuration,
    durationToKorean,
    findZone,
    cleanupOrphanedTempDirs,
    getZoneSetting
} = require('./utils/helpers');

// 녹화 핵심 로직(services/recording.js)에서 가져오는 함수/상태
// captureRegionBuffer, captureAndSave, finalizeRecord, updateStatusMessage,
// createStatusMessageAndFinalize, processEncodeQueue, performFinalizeRecord,
// cleanupRecord, migrateLegacySessionIds, processRecordings, encodeQueue,
// pendingArtworkRecords 는 모두 services/recording.js 로 옮겨졌습니다.
// client가 이미 만들어져 있는 시점(섹션 4 이후)이라 여기서 바로 불러옵니다.
const {
    captureRegionBuffer,
    captureAndSave,
    finalizeRecord,
    updateStatusMessage,
    createStatusMessageAndFinalize,
    processEncodeQueue,
    performFinalizeRecord,
    cleanupRecord,
    migrateLegacySessionIds,
    processRecordings,
    encodeQueue,
    pendingArtworkRecords
} = require('./services/recording')(client);


// ========================================
// 7. 명령어 시스템
// ========================================
// 7-1단계에서 옮긴 명령어들이 의존하는 것들 (client, sendAlert, lastAlertTime).
// sendAlert는 아직 index.js 안의 함수 선언(호이스팅)이라 이 시점에도 참조 가능합니다.
const commandDeps = { client, sendAlert, lastAlertTime };
const extractedCommands = require('./commands')(commandDeps);

const commands = {
    ...extractedCommands,
    // 아래는 아직 옮기지 않은 명령어들입니다 (7-3 단계: status, updatenotif, leaveserver, whitelist, record + 계획서에 없던 flag/history/servers 포함 예정).
    'status': async (message) => {
        const setting = await Setting.findOne({ guildId: message.guild.id });
    
    const embed = new EmbedBuilder()
        .setTitle('📊 Wcam 봇 상태')
        .setColor(0x0099FF)
        .setTimestamp();
    
    // 감시 중인 구역
    const zoneList = monitorZones.map(z => z.name).join('\n');
    embed.addFields({ name: '🔍 감시 중인 구역', value: zoneList, inline: false });
    
    if (setting) {
        // 전역 설정
        const globalSettings = 
            `**상태:** ${setting.enabled ? '✅ 활성화' : '⏸️ 일시 정지'}\n` +
            `**쿨다운:** ${setting.cooldownTime / 60000}분`;
        embed.addFields({ name: '⚙️ 전역 설정', value: globalSettings, inline: false });
        
        // 기본 설정
        const defaultChannel = setting.defaultChannelId ? `<#${setting.defaultChannelId}>` : '미설정';
        const defaultRole = setting.defaultRoleId 
            ? (message.guild.roles.cache.get(setting.defaultRoleId)?.name || setting.defaultRoleId)
            : '미설정';
        const defaultThreshold = setting.defaultThreshold || 90;
        
        const defaultSettings = 
            `**채널:** ${defaultChannel}\n` +
            `**역할:** ${defaultRole}\n` +
            `**임계값:** ${defaultThreshold}%`;
        embed.addFields({ name: '📌 기본 설정', value: defaultSettings, inline: false });
        
        // 구역별 개별 설정
        if (setting.zones && setting.zones.size > 0) {
            let zoneSettings = '';
            for (const [zoneName, zoneConfig] of setting.zones) {
                const parts = [];
                if (zoneConfig.channelId) {
                    parts.push(`채널: <#${zoneConfig.channelId}>`);
                }
                if (zoneConfig.roleId) {
                    const role = message.guild.roles.cache.get(zoneConfig.roleId);
                    parts.push(`역할: ${role ? role.name : zoneConfig.roleId}`);
                }
                if (zoneConfig.threshold !== undefined) {
                    parts.push(`임계값: ${zoneConfig.threshold}%`);
                }
                if (zoneConfig.enabled === false) {
                    parts.push(`⏸️ 비활성화`);
                }
                
                if (parts.length > 0) {
                    zoneSettings += `**${zoneName}**\n${parts.join(' | ')}\n\n`;
                }
            }
            
            if (zoneSettings) {
                embed.addFields({ name: '🎯 구역별 개별 설정', value: zoneSettings.trim(), inline: false });
            }
        }
    } else {
        embed.setDescription('아직 설정되지 않았습니다.\n`w!setchannel`과 `w!setrole`로 설정해주세요.');
    }
    
    message.reply({ embeds: [embed] });
},

   'f': async (message, args) => commands['flag'](message, args),
   'flag': async (message, args) => {
        const zoneName = args.join(' ');
        if (!zoneName) return message.reply('❌ 확인할 구역 이름을 입력해주세요. (예: w!flag 독도)');

        const zone = findZone(zoneName);
        if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

        const statusMsg = await message.reply(`🔍 ${zone.name}의 실시간 이미지를 분석 중입니다...`);

        try {
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            const currentFlagBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .ensureAlpha()
                .toBuffer();

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

            const setting = await Setting.findOne({ guildId: message.guild.id });
            const serverThreshold = getZoneSetting(setting, zone.name, 'threshold') || 90;

            const attachment = new AttachmentBuilder(currentFlagBuffer, { name: 'current_flag.png' });
            const matchPixels = totalPixels - numDiffPixels;

            const buildOriginalEmbed = (matchPct, matchPx, totalPx, diffPx, threshold) =>
                new EmbedBuilder()
                    .setTitle(`🖼️ 실시간 감시 화면: ${zone.name}`)
                    .setURL(zone.wplaceUrl)
                    .addFields(
                        { name: '현재 일치율', value: `**${matchPct.toFixed(2)}%**`, inline: true },
                        { name: '감시 기준', value: `${threshold}%`, inline: true },
                        { name: '픽셀 정보', value: `일치: ${matchPx.toLocaleString()}/${totalPx.toLocaleString()}\n불일치: ${diffPx.toLocaleString()}개`, inline: false }
                    )
                    .setDescription(
                        matchPct < threshold
                            ? "⚠️ **주의: 현재 태극기가 훼손되었을 가능성이 있습니다!**"
                            : "✅ 현재 일치율이 임계값 이상입니다."
                    )
                    .setColor(matchPct < threshold ? 0xFF0000 : 0x00FF00)
                    .setImage('attachment://current_flag.png')
                    .setTimestamp();

            // 오버레이 이미지 생성 함수
            const buildOverlayBuffer = async () => {
                const overlayImg = PNG.sync.read(fs.readFileSync(zone.originalPath));
                const currentImgForOverlay = PNG.sync.read(currentFlagBuffer);
                const overlayPng = new PNG({ width, height });

                for (let i = 0; i < width * height; i++) {
                    const idx = i * 4;
                    // 현재 이미지 픽셀을 기본으로 사용
                    overlayPng.data[idx]     = currentImgForOverlay.data[idx];
                    overlayPng.data[idx + 1] = currentImgForOverlay.data[idx + 1];
                    overlayPng.data[idx + 2] = currentImgForOverlay.data[idx + 2];
                    overlayPng.data[idx + 3] = 255;

                    // 참조 이미지와 비교하여 색상 오버레이 적용
                    const rDiff = Math.abs(currentImgForOverlay.data[idx]     - overlayImg.data[idx]);
                    const gDiff = Math.abs(currentImgForOverlay.data[idx + 1] - overlayImg.data[idx + 1]);
                    const bDiff = Math.abs(currentImgForOverlay.data[idx + 2] - overlayImg.data[idx + 2]);
                    const isDiff = (rDiff + gDiff + bDiff) > 30; // 임계값 (0.1 * 255 * 3 ≈ 76, 더 느슨하게)

                    if (isDiff) {
                        // 불일치: 빨간색 반투명 오버레이
                        overlayPng.data[idx]     = Math.min(255, currentImgForOverlay.data[idx]     * 0.4 + 180);
                        overlayPng.data[idx + 1] = Math.floor(currentImgForOverlay.data[idx + 1] * 0.3);
                        overlayPng.data[idx + 2] = Math.floor(currentImgForOverlay.data[idx + 2] * 0.3);
                    } else {
                        // 일치: 초록색 반투명 오버레이
                        overlayPng.data[idx]     = Math.floor(currentImgForOverlay.data[idx]     * 0.3);
                        overlayPng.data[idx + 1] = Math.min(255, currentImgForOverlay.data[idx + 1] * 0.4 + 120);
                        overlayPng.data[idx + 2] = Math.floor(currentImgForOverlay.data[idx + 2] * 0.3);
                    }
                }

                return PNG.sync.write(overlayPng);
            };

            // 버튼 생성
            const diffButton = new ButtonBuilder()
                .setCustomId(`flag_diff_${message.id}`)
                .setLabel('🔴 불일치 픽셀 확인')
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(diffButton);

            await statusMsg.delete();
            const sentMsg = await message.channel.send({
                embeds: [buildOriginalEmbed(matchPercentage, matchPixels, totalPixels, numDiffPixels, serverThreshold)],
                files: [attachment],
                components: [row]
            });

            // 버튼 인터랙션 처리 (5분 타임아웃)
            const collector = sentMsg.createMessageComponentCollector({ time: 5 * 60 * 1000 });
            let showingOverlay = false;

            collector.on('collect', async (interaction) => {
                await interaction.deferUpdate();

                if (!showingOverlay) {
                    // 오버레이 이미지로 전환
                    const overlayBuffer = await buildOverlayBuffer();
                    const overlayAttachment = new AttachmentBuilder(overlayBuffer, { name: 'current_flag.png' });
                    const overlayEmbed = new EmbedBuilder()
                        .setTitle(`🔍 픽셀 일치 현황: ${zone.name}`)
                        .setURL(zone.wplaceUrl)
                        .setDescription('🟢 일치 픽셀 | 🔴 불일치 픽셀')
                        .addFields(
                            { name: '현재 일치율', value: `**${matchPercentage.toFixed(2)}%**`, inline: true },
                            { name: '픽셀 정보', value: `일치: ${matchPixels.toLocaleString()}/${totalPixels.toLocaleString()}\n불일치: ${numDiffPixels.toLocaleString()}개`, inline: false }
                        )
                        .setColor(0x5865F2)
                        .setImage('attachment://current_flag.png')
                        .setTimestamp();

                    const backButton = new ButtonBuilder()
                        .setCustomId(`flag_diff_${message.id}`)
                        .setLabel('🖼️ 원본 이미지 보기')
                        .setStyle(ButtonStyle.Secondary);

                    await sentMsg.edit({
                        embeds: [overlayEmbed],
                        files: [overlayAttachment],
                        components: [new ActionRowBuilder().addComponents(backButton)]
                    });
                    showingOverlay = true;
                } else {
                    // 원본 이미지로 복원
                    const origAttachment = new AttachmentBuilder(currentFlagBuffer, { name: 'current_flag.png' });
                    const origButton = new ButtonBuilder()
                        .setCustomId(`flag_diff_${message.id}`)
                        .setLabel('🔴 불일치 픽셀 확인')
                        .setStyle(ButtonStyle.Secondary);

                    await sentMsg.edit({
                        embeds: [buildOriginalEmbed(matchPercentage, matchPixels, totalPixels, numDiffPixels, serverThreshold)],
                        files: [origAttachment],
                        components: [new ActionRowBuilder().addComponents(origButton)]
                    });
                    showingOverlay = false;
                }
            });

            // 5분 후 버튼 비활성화
            collector.on('end', async () => {
                await sentMsg.edit({ components: [] }).catch(() => {});
            });

        } catch (error) {
            console.error(error);
            message.reply('❌ 이미지 분석 중 오류가 발생했습니다.');
        }
    },

    'updatenotif': async (message) => {
    // 1. 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    const statusMsg = await message.reply('📢 업데이트 알림을 전송하는 중...');
    
    let successCount = 0;
    let failCount = 0;
    const failedServers = [];

    // 2. 모든 서버 순회
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            // 메시지 전송 권한이 있는 첫 번째 텍스트 채널 찾기
            const channel = guild.channels.cache.find(ch => 
                ch.isTextBased() && 
                ch.permissionsFor(guild.members.me).has('SendMessages') &&
                ch.permissionsFor(guild.members.me).has('EmbedLinks')
            );
            
            if (!channel) {
                failCount++;
                failedServers.push(`${guild.name} (전송 가능한 채널 없음)`);
                continue;
            }

            // 임베드 메시지 생성
            const embed = new EmbedBuilder()
                .setTitle('🔔 봇 업데이트 알림')
                .setDescription('봇이 업데이트 되었습니다.\n`w!status` 명령어를 사용하여 서버 설정을 다시 한번 확인해주세요.')
                .setColor(0x0099FF)
                .setTimestamp();

            // 메시지 전송 (멘션 없음)
            await channel.send({ embeds: [embed] });
            successCount++;
            
        } catch (error) {
            console.error(`알림 전송 실패 (${guild.name}):`, error.message);
            failCount++;
            failedServers.push(`${guild.name} (오류: ${error.message})`);
        }
    }

    // 3. 결과 보고
    const resultEmbed = new EmbedBuilder()
        .setTitle('📊 업데이트 알림 전송 완료')
        .setColor(failCount > 0 ? 0xFFA500 : 0x00FF00)
        .addFields(
            { name: '✅ 성공', value: `${successCount}개 서버`, inline: true },
            { name: '❌ 실패', value: `${failCount}개 서버`, inline: true },
            { name: '📈 전체', value: `${client.guilds.cache.size}개 서버`, inline: true }
        )
        .setTimestamp();

    if (failedServers.length > 0) {
        const failedList = failedServers.slice(0, 10).join('\n');
        const moreText = failedServers.length > 10 ? `\n... 외 ${failedServers.length - 10}개` : '';
        resultEmbed.addFields({ 
            name: '⚠️ 실패한 서버 목록', 
            value: failedList + moreText, 
            inline: false 
        });
    }

    await statusMsg.edit({ content: null, embeds: [resultEmbed] });
},

'servers': async (message) => {
    // 1. 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    const statusMsg = await message.reply('📊 서버 목록을 불러오는 중...');
    
    // 2. 서버 정보 수집
    const guilds = Array.from(client.guilds.cache.values());
    
    // 총 통계
    const totalMembers = guilds.reduce((sum, g) => sum + g.memberCount, 0);
    const totalChannels = guilds.reduce((sum, g) => sum + g.channels.cache.size, 0);
    
    // 3. 서버 목록을 여러 페이지로 나누기 (한 페이지당 10개)
    const PAGE_SIZE = 10;
    const totalPages = Math.ceil(guilds.length / PAGE_SIZE);
    
    const createEmbed = async (pageIndex) => {
        const start = pageIndex * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, guilds.length);
        const pageGuilds = guilds.slice(start, end);
        
        const embed = new EmbedBuilder()
            .setTitle(`🌐 봇 서버 목록 (${pageIndex + 1}/${totalPages})`)
            .setColor(0x0099FF)
            .setDescription(
                `**전체 통계**\n` +
                `📊 총 서버: ${guilds.length}개\n` +
                `👥 총 멤버: ${totalMembers.toLocaleString()}명\n` +
                `📺 총 채널: ${totalChannels.toLocaleString()}개\n\n` +
                `**서버 목록 (${start + 1}-${end}/${guilds.length})**`
            )
            .setTimestamp();
        
        // 각 서버 정보 추가
        for (const guild of pageGuilds) {
            const owner = await client.users.fetch(guild.ownerId).catch(() => null);
            const ownerTag = owner ? `${owner.tag}` : '알 수 없음';
            
            // 서버 설정 정보 가져오기
            const setting = await Setting.findOne({ guildId: guild.id });
            const hasSetup = setting && setting.defaultChannelId ? '✅' : '⚠️';
            
            const info = 
                `**ID:** \`${guild.id}\`\n` +
                `👥 멤버: ${guild.memberCount.toLocaleString()}명\n` +
                `📺 채널: ${guild.channels.cache.size}개\n` +
                `👑 소유자: ${ownerTag}\n` +
                `${hasSetup} 설정 상태\n` +
                `📅 가입일: <t:${Math.floor(guild.joinedTimestamp / 1000)}:R>`;
            
            embed.addFields({
                name: `${guild.name}`,
                value: info,
                inline: false
            });
        }
        
        return embed;
    };
    
    // 4. 첫 페이지 전송
    let currentPage = 0;
    const firstEmbed = await createEmbed(0);
    
    // 페이지가 1개면 버튼 없이 전송
    if (totalPages === 1) {
        return await statusMsg.edit({ content: null, embeds: [firstEmbed] });
    }
    
    // 5. 페이지 네비게이션 버튼 생성
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
    
    const getButtons = (page) => {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('first')
                    .setLabel('⏮️ 첫 페이지')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('prev')
                    .setLabel('◀ 이전')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('page')
                    .setLabel(`${page + 1} / ${totalPages}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('다음 ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1),
                new ButtonBuilder()
                    .setCustomId('last')
                    .setLabel('마지막 페이지 ⏭️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
        return row;
    };
    
    // 6. 초기 메시지 업데이트
    const serverListMsg = await statusMsg.edit({
        content: null,
        embeds: [firstEmbed],
        components: [getButtons(currentPage)]
    });
    
    // 7. 버튼 클릭 이벤트 리스너
    const collector = serverListMsg.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 600000 // 10분간 버튼 활성화
    });
    
    collector.on('collect', async (interaction) => {
        if (interaction.customId === 'first') {
            currentPage = 0;
        } else if (interaction.customId === 'prev') {
            currentPage = Math.max(0, currentPage - 1);
        } else if (interaction.customId === 'next') {
            currentPage = Math.min(totalPages - 1, currentPage + 1);
        } else if (interaction.customId === 'last') {
            currentPage = totalPages - 1;
        }
        
        const newEmbed = await createEmbed(currentPage);
        await interaction.update({
            embeds: [newEmbed],
            components: [getButtons(currentPage)]
        });
    });
    
    collector.on('end', () => {
        // 10분 후 버튼 비활성화
        serverListMsg.edit({
            components: []
        }).catch(() => {}); // 메시지가 삭제된 경우 무시
    });
},

    'leaveserver': async (message, args) => {
        // 1. 개발자 본인 확인 (DEVELOPER_ID는 상단에 정의된 변수 사용)
        if (message.author.id !== DEVELOPER_ID) {
            return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
        }

        // 2. 서버 ID 인자 확인
        const targetGuildId = args[0];
        if (!targetGuildId) {
            return message.reply('❌ 퇴장할 서버 ID를 입력해주세요. 사용법: `w!leaveserver (서버 ID)`');
        }

        try {
            // 3. 봇이 해당 서버에 있는지 확인
            const guild = client.guilds.cache.get(targetGuildId);
            if (!guild) {
                return message.reply('❌ 봇이 해당 서버에 참여하고 있지 않거나, 잘못된 서버 ID입니다.');
            }

            const guildName = guild.name;

            // 4. 서버 퇴장 실행
            await guild.leave();

            // 5. 결과 보고 (콘솔 및 채팅)
            console.log(`🖕 개발자 지시로 ${guildName}에서 퇴장하였습니다.`);
            message.reply(`✅ 성공적으로 **${guildName}** 서버에서 퇴장하였습니다.`);

        } catch (error) {
            console.error('서버 퇴장 중 오류 발생:', error);
            message.reply('❌ 서버에서 퇴장하는 중 예외가 발생했습니다. 콘솔 로그를 확인해주세요.');
        }
    },

    'whitelist': async (message, args) => {
    // 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    const action = args[0]?.toLowerCase();
    
    // 사용법 안내
    if (!action || !['add', 'remove', 'list'].includes(action)) {
        const whitelistCount = await Whitelist.countDocuments();
        return message.reply(
            '**화이트리스트 관리**\n' +
            '• `w!whitelist add [서버ID]` - 서버 추가\n' +
            '• `w!whitelist remove [서버ID]` - 서버 제거\n' +
            '• `w!whitelist list` - 목록 확인\n\n' +
            `**현재 상태:** ${whitelistCount}개 서버 등록됨`
        );
    }
    
    // 목록 확인
    if (action === 'list') {
        const whitelisted = await Whitelist.find().sort({ addedAt: -1 });
        
        if (whitelisted.length === 0) {
            return message.reply('📋 화이트리스트가 비어있습니다.');
        }
        
        // 페이지네이션 설정
        const PAGE_SIZE = 10;
        const totalPages = Math.ceil(whitelisted.length / PAGE_SIZE);
        
        const createListEmbed = (pageIndex) => {
            const start = pageIndex * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, whitelisted.length);
            const pageItems = whitelisted.slice(start, end);
            
            const embed = new EmbedBuilder()
                .setTitle(`📋 화이트리스트 서버 목록 (${pageIndex + 1}/${totalPages})`)
                .setColor(0x00FF00)
                .setDescription(`총 ${whitelisted.length}개 서버 등록`)
                .setTimestamp();
            
            for (const item of pageItems) {
                const guild = client.guilds.cache.get(item.guildId);
                const status = guild ? '✅ 참여 중' : '❌ 미참여';
                const currentMembers = guild ? `${guild.memberCount}명` : `${item.memberCount || '?'}명`;
                
                const info = 
                    `**ID:** \`${item.guildId}\`\n` +
                    `${status} | 멤버: ${currentMembers}\n` +
                    `소유자: ${item.ownerTag || '정보 없음'}\n` +
                    `등록일: <t:${Math.floor(item.addedAt.getTime() / 1000)}:R>`;
                
                embed.addFields({
                    name: item.guildName || '알 수 없는 서버',
                    value: info,
                    inline: false
                });
            }
            
            return embed;
        };
        
        let currentPage = 0;
        const firstEmbed = createListEmbed(0);
        
        // 페이지가 1개면 버튼 없이 전송
        if (totalPages === 1) {
            return message.reply({ embeds: [firstEmbed] });
        }
        
        // 페이지네이션 버튼
        const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
        
        const getButtons = (page) => {
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('first')
                        .setLabel('⏮️')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('prev')
                        .setLabel('◀')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('page')
                        .setLabel(`${page + 1}/${totalPages}`)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('next')
                        .setLabel('▶')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1),
                    new ButtonBuilder()
                        .setCustomId('last')
                        .setLabel('⏭️')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1)
                );
            return row;
        };
        
        const listMsg = await message.reply({
            embeds: [firstEmbed],
            components: [getButtons(currentPage)]
        });
        
        const collector = listMsg.createMessageComponentCollector({
            filter: (i) => i.user.id === message.author.id,
            time: 600000
        });
        
        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'first') currentPage = 0;
            else if (interaction.customId === 'prev') currentPage = Math.max(0, currentPage - 1);
            else if (interaction.customId === 'next') currentPage = Math.min(totalPages - 1, currentPage + 1);
            else if (interaction.customId === 'last') currentPage = totalPages - 1;
            
            await interaction.update({
                embeds: [createListEmbed(currentPage)],
                components: [getButtons(currentPage)]
            });
        });
        
        collector.on('end', () => {
            listMsg.edit({ components: [] }).catch(() => {});
        });
        
        return;
    }
    
    // 서버 추가
    if (action === 'add') {
        const guildId = args[1];
        if (!guildId) {
            return message.reply('❌ 추가할 서버 ID를 입력해주세요.');
        }
        
        // 이미 등록되어 있는지 확인
        const existing = await Whitelist.findOne({ guildId });
        if (existing) {
            return message.reply('⚠️ 이미 화이트리스트에 등록된 서버입니다.');
        }
        
        // 서버 정보 가져오기
        const guild = client.guilds.cache.get(guildId);
        let guildName = '알 수 없는 서버';
        let ownerTag = '알 수 없음';
        let memberCount = 0;
        
        if (guild) {
            guildName = guild.name;
            memberCount = guild.memberCount;
            const owner = await client.users.fetch(guild.ownerId).catch(() => null);
            ownerTag = owner ? owner.tag : '알 수 없음';
        }
        
        // DB에 추가
        await Whitelist.create({
            guildId,
            guildName,
            addedBy: message.author.tag,
            ownerTag,
            memberCount
        });
        
        const embed = new EmbedBuilder()
            .setTitle('✅ 서버가 화이트리스트에 추가되었습니다')
            .setColor(0x00FF00)
            .addFields(
                { name: '서버 이름', value: guildName, inline: true },
                { name: '서버 ID', value: guildId, inline: true },
                { name: '멤버 수', value: `${memberCount}명`, inline: true },
                { name: '소유자', value: ownerTag, inline: true },
                { name: '등록자', value: message.author.tag, inline: true },
                { name: '봇 참여 상태', value: guild ? '✅ 참여 중' : '❌ 미참여', inline: true }
            )
            .setFooter({ text: guild ? '정상적으로 사용 가능합니다' : '봇 초대 시 정상 작동합니다' })
            .setTimestamp();
        
        return message.reply({ embeds: [embed] });
    }
    
    // 서버 제거
    if (action === 'remove') {
        const guildId = args[1];
        if (!guildId) {
            return message.reply('❌ 제거할 서버 ID를 입력해주세요.');
        }
        
        const existing = await Whitelist.findOne({ guildId });
        if (!existing) {
            return message.reply('⚠️ 해당 서버는 화이트리스트에 없습니다.');
        }
        
        // DB에서 제거
        await Whitelist.deleteOne({ guildId });
        
        // 봇이 해당 서버에 있다면 자동 퇴장
        const guild = client.guilds.cache.get(guildId);
        let leftServer = false;
        
        if (guild) {
            try {
                await guild.leave();
                leftServer = true;
                console.log(`📤 화이트리스트 제거로 인해 ${guild.name}에서 퇴장`);
            } catch (error) {
                console.error(`퇴장 실패 (${guild.name}):`, error);
            }
        }
        
        const embed = new EmbedBuilder()
            .setTitle('✅ 서버가 화이트리스트에서 제거되었습니다')
            .setColor(0xFFA500)
            .addFields(
                { name: '서버 이름', value: existing.guildName || '알 수 없음', inline: true },
                { name: '서버 ID', value: guildId, inline: true },
                { name: '자동 퇴장', value: leftServer ? '✅ 완료' : '❌ 미참여 중', inline: true }
            )
            .setTimestamp();
        
        return message.reply({ embeds: [embed] });
    }
},

'h': async (message, args) => commands['history'](message, args),
'history': async (message, args) => {
    const zoneName = args.join(' ');
        if (!zoneName) return message.reply('❌ 확인할 구역 이름을 입력해주세요. (예: w!history 독도)');

        const zone = findZone(zoneName);
        if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

    // 쌓인 모든 데이터 가져오기 (최대 최근 60개)
    const history = (zoneHistory[zone.name] || []).slice(-60);

    try {
                const configuration = {
    type: 'line',
    data: {
        labels: history.map(h => new Date(h.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Seoul' })),
        datasets: [{
            label: '일치율 (%)',
            data: history.map(h => h.percentage),
            borderColor: 'rgb(54, 162, 235)',
            backgroundColor: 'rgba(54, 162, 235, 0.3)',
            borderWidth: 3,
            pointRadius: 5,
            pointBackgroundColor: 'rgb(54, 162, 235)',
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            tension: 0.4,
            fill: true
        }]
    },
    options: {
        responsive: true,
        plugins: {
            title: {
                display: true,
                text: `${zone.name} - 일치율 변화`,
                font: { size: 36, weight: 'bold' },
                color: '#333'
            },
            legend: { 
                display: true,
                labels: {
                    color: '#333',
                    font: { size: 28 }
                }
            }
        },
        scales: {
            y: {
                beginAtZero: false,
                min: Math.max(0, Math.floor(Math.min(...history.map(h => h.percentage)) - 5)),
                max: 100,
                ticks: {
                    color: '#666',
                    stepSize: 0.5,
                    callback: function(value) {
                    return value.toFixed(1) + '%';
                 }
               },
                grid: {
                    color: 'rgba(0, 0, 0, 0.1)',
                    drawBorder: true
                },
                title: { 
                    display: true, 
                    text: '일치율 (%)',
                    color: '#333',
                    font: { size: 30 }
                }
            },
            x: {
                ticks: {
                    color: '#666'
                },
                grid: {
                    color: 'rgba(0, 0, 0, 0.1)',
                    drawBorder: true
                },
                title: { 
                    display: true, 
                    text: '시간',
                    color: '#333',
                    font: { size: 30 }
                }
            }
        },
        backgroundColor: '#FFFFFF'
    },
    plugins: [{
        id: 'customCanvasBackgroundColor',
        beforeDraw: (chart) => {
            const ctx = chart.canvas.getContext('2d');
            ctx.save();
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, chart.width, chart.height);
            ctx.restore();
        }
    }]
};

        const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'history.png' });

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${zone.name} 일치율 변화`)
            .setDescription(`최근 30분간의 일치율 변화 그래프입니다.`)
            .setColor(0x00AE86)
            .setImage('attachment://history.png')
            .addFields(
                { name: '데이터 포인트', value: `${history.length}개`, inline: true },
                { name: '최고 일치율', value: `${Math.max(...history.map(h => h.percentage)).toFixed(2)}%`, inline: true },
                { name: '최저 일치율', value: `${Math.min(...history.map(h => h.percentage)).toFixed(2)}%`, inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed], files: [attachment] });
    } catch (error) {
        console.error('그래프 생성 오류:', error);
        message.reply('❌ 그래프 생성 중 오류가 발생했습니다.');
    }
},

'r': async (message, args) => commands['record'](message, args),
'record': async (message, args) => {

    // ── w!record test (개발자 전용 스트레스 테스트) ────────────────────
if (args[0] === 'test') {
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    // 기존 테스트 세션 잔여물 정리
    await cleanupRecord(message.author.id, 'flag');

    const statusMsg = await message.reply('🧪 **[녹화 스트레스 테스트]** 독도 태극기 프레임 캡처 중...');

    try {
        const zone = monitorZones.find(z => z.name === '독도 태극기');
        if (!zone) return statusMsg.edit('❌ 독도 태극기 구역을 찾을 수 없습니다.');

        // ① 현재 독도 태극기 프레임 1장 캡처
        const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
        const frameBuffer = await sharp(Buffer.from(response.data))
            .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
            .toBuffer();

        await statusMsg.edit('🧪 **[녹화 스트레스 테스트]** 프레임 2880장 DB 저장 중...');

        // ② RecordSession 생성 (이미 완료된 상태로)
        const testSession = await new RecordSession({
            userId: message.author.id,
            sessionType: 'flag',
            sessionId: generateSessionId(),
            zoneName: zone.name,
            frameCount: 2880,
            endTime: new Date(),
            isActive: false,
            commandChannelId: message.channel.id,
            statusChannelId: message.channel.id,
            statusMessageId: statusMsg.id
        }).save();

        // ③ 프레임 2880장 배치 삽입 (100개씩)
        const TEST_FRAME_COUNT = 2880;
        const BATCH_SIZE = 100;
        const baseTime = new Date();
        let inserted = 0;

        for (let i = 0; i < TEST_FRAME_COUNT; i += BATCH_SIZE) {
            const batch = [];
            const end = Math.min(i + BATCH_SIZE, TEST_FRAME_COUNT);
            for (let j = i; j < end; j++) {
                batch.push({
                    userId: message.author.id,
                    sessionType: 'flag',
                    frameData: frameBuffer,
                    timestamp: new Date(baseTime.getTime() + j * 30000) // 30초 간격 시뮬레이션
                });
            }
            await RecordFrame.insertMany(batch);
            inserted += batch.length;

            // 500장마다 진행상황 업데이트
            if (inserted % 500 === 0 || inserted === TEST_FRAME_COUNT) {
                await statusMsg.edit(`🧪 **[녹화 스트레스 테스트]** 프레임 저장 중... (${inserted}/${TEST_FRAME_COUNT})`);
            }
        }

        await statusMsg.edit('🧪 **[녹화 스트레스 테스트]** 저장 완료! 인코딩 큐에 추가합니다...');
        console.log(`🧪 [TEST] ${message.author.id} - 테스트 프레임 2880장 저장 완료, 인코딩 시작`);

        // ④ 실제 녹화와 동일하게 인코딩 실행
        await finalizeRecord(message.author.id, 'flag');

    } catch (err) {
        console.error('record test 오류:', err);
        await statusMsg.edit(`❌ 테스트 중 오류 발생: ${err.message}`);
    }
    return;
}
    // ── w!record recover (ID) — 오류로 중단된 녹화 복구 ──────────────
    if (args[0] === 'recover') {
        const targetId = (args[1] || '').trim().toUpperCase();
        if (!targetId) {
            return message.reply("❌ 사용법: `w!record recover (ID)`\n(ID는 오류 발생 시 상태 메시지에 안내된 코드입니다)");
        }

        // 🔒 본인이 시작한 녹화만 복구 가능 (userId가 일치하지 않으면 조회 자체가 안 됨 → 타인 영상이 전송될 수 없음)
        const session = await RecordSession.findOne({
            userId: message.author.id,
            sessionId: targetId,
            needsRecovery: true
        });

        if (!session) {
            return message.reply(`❌ ID \`${targetId}\`에 해당하는, 본인이 시작한 복구 대기 중인 녹화를 찾을 수 없습니다.`);
        }

        const frameCount = await RecordFrame.countDocuments({ userId: message.author.id, sessionType: session.sessionType });
        if (frameCount === 0) {
            return message.reply(`❌ 복구할 프레임이 남아있지 않습니다. (ID: \`${targetId}\`)`);
        }

        const statusMsg = await message.reply(
            `🔁 복구를 시작합니다. (ID: \`${targetId}\`, 프레임 ${frameCount}개)\n` +
            `이 메시지가 진행 상황/완료 안내로 갱신됩니다.`
        );
        await RecordSession.updateOne(
            { _id: session._id },
            { needsRecovery: false, statusChannelId: message.channel.id, statusMessageId: statusMsg.id }
        );
        finalizeRecord(session.userId, session.sessionType);
        return;
    }

    // ── w!record stop ──────────────────────────────────────────────
    if (args[0] === 'stop') {
        const sessions = await RecordSession.find({ userId: message.author.id, isActive: true });

        if (sessions.length === 0) {
            return message.reply("❌ 현재 진행 중인 녹화가 없습니다.");
        }

        const artworkSession = sessions.find(s => s.sessionType === 'artwork');
        const flagSession    = sessions.find(s => s.sessionType === 'flag');

        // 두 가지 녹화 동시 진행 중 → 선택지 제공
        if (artworkSession && flagSession) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`stop_select_artwork_${message.author.id}`)
                    .setLabel('🎨 작품 타임랩스')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`stop_select_flag_${message.author.id}`)
                    .setLabel('🚩 태극기 녹화')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`stop_select_cancel_${message.author.id}`)
                    .setLabel('취소')
                    .setStyle(ButtonStyle.Danger)
            );
            return message.reply({
                content: "⏺️ 현재 두 개의 녹화가 진행 중입니다. 중지할 녹화를 선택해주세요.",
                components: [row]
            });
        }

        // 작품 녹화만 진행 중
        if (artworkSession) {
            const frameCount = artworkSession.frameCount || 0;
            const confirmEmbed = new EmbedBuilder()
                .setTitle("🎨 작품 타임랩스 중단 확인")
                .setDescription(
                    `현재까지 **${frameCount}/2880** 프레임이 녹화되었습니다.\n\n` +
                    `정말 녹화를 중지하시겠습니까?\n` +
                    `중지하면 지금까지 녹화된 영상이 DM으로 전송됩니다.`
                )
                .setColor(0xFFA500);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`confirm_stop_artwork_${message.author.id}`).setLabel('✅ 중지').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`cancel_stop_record_${message.author.id}`).setLabel('취소').setStyle(ButtonStyle.Secondary)
            );
            return message.reply({ embeds: [confirmEmbed], components: [row] });
        }

        // 태극기 녹화만 진행 중
        if (flagSession) {
            const frameCount = flagSession.frameCount || 0;
            const confirmEmbed = new EmbedBuilder()
                .setTitle("🎥 태극기 녹화 중단 확인")
                .setDescription(
                    `현재까지 **${frameCount}** 프레임이 녹화되었습니다.\n\n` +
                    `정말 녹화를 중지하시겠습니까?\n` +
                    `지금까지 녹화된 이미지는 MP4로 변환되어 DM으로 전송됩니다.`
                )
                .setColor(0xFFA500);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('confirm_stop_record').setLabel('확인').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('cancel_stop_record').setLabel('취소').setStyle(ButtonStyle.Secondary)
            );
            return message.reply({ embeds: [confirmEmbed], components: [row] });
        }
        return;
    }

    // ── w!record (tileX) (tileY) (localX) (localY) + 첨부 이미지 ──
    // 첫 번째 인자가 숫자이면 작품 녹화
    if (!isNaN(parseInt(args[0]))) {
        if (args.length < 4) {
            return message.reply(
                "❌ 사용법: `w!record (타일X) (타일Y) (로컬X) (로컬Y)` + 도안 이미지 첨부\n" +
                "예: `w!record 100 200 500 300` (도안 이미지 함께 첨부 필수)\n\n" +
                "녹화 중지/상태 확인: `w!record stop`"
            );
        }

        const tileX  = parseInt(args[0]);
        const tileY  = parseInt(args[1]);
        const localX = Math.max(0, Math.min(999, parseInt(args[2])));
        const localY = Math.max(0, Math.min(999, parseInt(args[3])));

        if ([tileX, tileY, localX, localY].some(isNaN)) {
            return message.reply("❌ 좌표는 모두 숫자로 입력해주세요.");
        }

        const imgAttachment = message.attachments.first();
        if (!imgAttachment || !imgAttachment.contentType?.startsWith('image/')) {
            return message.reply("❌ 도안 이미지를 함께 첨부해주세요. (PNG, JPG 등)");
        }

        const existingArtwork = await RecordSession.findOne({
            userId: message.author.id, sessionType: 'artwork', isActive: true
        });
        if (existingArtwork) {
            return message.reply("❌ 이미 작품 타임랩스 녹화가 진행 중입니다. `w!record stop`으로 먼저 중지해주세요.");
        }

        const recoveryPendingArtwork = await RecordSession.findOne({
            userId: message.author.id, sessionType: 'artwork', needsRecovery: true
        });
        if (recoveryPendingArtwork) {
            return message.reply(
                `❌ 이전 작품 녹화(ID: \`${recoveryPendingArtwork.sessionId}\`)가 영상 생성 중 오류로 중단되어 복구 대기 중입니다.\n` +
                `먼저 \`w!record recover ${recoveryPendingArtwork.sessionId}\` 명령어로 복구를 시도해주세요.`
            );
        }

        const statusMsg = await message.reply("🔍 도안을 분석하고 미리보기를 준비하는 중...");

        try {
            // 도안 이미지 크기 파악
            const designRes  = await axios.get(imgAttachment.url, { responseType: 'arraybuffer' });
            const designMeta = await sharp(Buffer.from(designRes.data)).metadata();
            const captureWidth  = designMeta.width;
            const captureHeight = designMeta.height;

            // wplace 해당 영역 실시간 캡처 (미리보기)
            const previewBuffer     = await captureRegionBuffer(tileX, tileY, localX, localY, captureWidth, captureHeight);
            const previewAttachment = new AttachmentBuilder(previewBuffer, { name: 'preview.png' });

            const embed = new EmbedBuilder()
                .setTitle("🎨 작품 타임랩스 - 녹화 영역 확인")
                .setDescription(
                    `**위치:** 타일 (${tileX}, ${tileY}), 로컬 (${localX}, ${localY})\n` +
                    `**캡처 크기:** ${captureWidth} × ${captureHeight} 픽셀\n\n` +
                    `위 영역으로 녹화를 시작할까요?\n` +
                    `📌 30초마다 캡처하며, 변화가 없으면 자동으로 건너뜁니다.\n` +
                    `📌 최대 **2880 프레임** 도달 시 자동 종료됩니다.\n` +
                    `📌 기본 배경색은 바다색으로 설정됩니다.`
                )
                .setColor(0x0099FF)
                .setImage('attachment://preview.png')
                .setTimestamp();

            // 대기 중인 세션 임시 저장 (버튼 확인 대기용)
            pendingArtworkRecords.set(message.author.id, {
                tileX, tileY, localX, localY, captureWidth, captureHeight
            });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_start_artwork_${message.author.id}`)
                    .setLabel('✅ 녹화 시작')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`cancel_start_artwork_${message.author.id}`)
                    .setLabel('❌ 취소')
                    .setStyle(ButtonStyle.Danger)
            );

            await statusMsg.delete();
            await message.channel.send({ embeds: [embed], files: [previewAttachment], components: [row] });

        } catch (err) {
            console.error('record(작품) 오류:', err);
            await statusMsg.edit(`❌ 미리보기 생성 실패: ${err.message}`);
        }
        return;
    }

    // ── w!record (지역) (시간) — 기존 태극기 녹화 ──────────────────
    if (args.length < 2) {
        return message.reply(
            "❌ 사용법:\n" +
            "• 작품 타임랩스: `w!record (타일X) (타일Y) (로컬X) (로컬Y)` + 도안 이미지 첨부\n" +
            "• 태극기 녹화: `w!record (지역) (시간)` (예: `w!record 독도 30m`)\n" +
            "• 녹화 중지: `w!record stop`"
        );
    }

    const zone = findZone(args[0]);
    if (!zone) return message.reply(`❌ '${args[0]}' 구역을 찾을 수 없습니다.`);

    const durationMs = parseDuration(args[1]);
    if (!durationMs || durationMs <= 0 || durationMs > MAX_RECORD_DURATION_MS) {
        return message.reply("❌ 시간 형식이 잘못되었거나 범위를 초과했습니다. (최대 24시간)");
    }

    const existingFlag = await RecordSession.findOne({ userId: message.author.id, sessionType: 'flag', isActive: true });
    if (existingFlag) return message.reply("❌ 이미 태극기 녹화를 진행 중입니다.");

    const recoveryPendingFlag = await RecordSession.findOne({ userId: message.author.id, sessionType: 'flag', needsRecovery: true });
    if (recoveryPendingFlag) {
        return message.reply(
            `❌ 이전 녹화(ID: \`${recoveryPendingFlag.sessionId}\`)가 영상 생성 중 오류로 중단되어 복구 대기 중입니다.\n` +
            `먼저 \`w!record recover ${recoveryPendingFlag.sessionId}\` 명령어로 복구를 시도해주세요.`
        );
    }

    const endTime = new Date(Date.now() + durationMs);
    await new RecordSession({
        userId: message.author.id,
        sessionType: 'flag',
        sessionId: generateSessionId(),
        zoneName: zone.name,
        endTime: endTime,
        isActive: true,
        commandChannelId: message.channel.id
    }).save();

    try {
        const endUnix = Math.floor(endTime.getTime() / 1000);
        const koreanDuration = durationToKorean(args[1]);
        await message.author.send(
            `⏺️ **${zone.name}** 녹화가 시작되었습니다.\n` +
            `⏱️ **녹화 기간:** ${koreanDuration}\n` +
            `⏳ **종료 예정:** <t:${endUnix}:R> (<t:${endUnix}:f>)\n\n` +
            `종료 후 MP4 영상이 이곳으로 전송됩니다.`
        );
        message.reply(`${koreanDuration} 동안 **${zone.name}** 녹화를 진행합니다. 녹화 시작 DM을 전송하였습니다.`);
    } catch (e) {
        await cleanupRecord(message.author.id, 'flag');
        return message.reply("❌ DM을 보낼 수 없습니다. DM 설정을 확인해주세요.");
    }
},
    
};

// ========================================
// 8. 핵심 감시 로직
// ========================================
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

            // ✅ 일치율 데이터 저장
            zoneMatchData[zone.name] = {
                percentage: matchPercentage,
                timestamp: new Date().toISOString(),
                totalPixels: totalPixels,
                matchPixels: totalPixels - numDiffPixels,
                diffPixels: numDiffPixels
            };
            
            // ✅ 히스토리 저장
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

// ========================================
// 9. 알림 전송 함수
// ========================================
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

// ========================================
// 10. 이벤트 핸들러
// ========================================
client.on('messageCreate', async (message) => {
    if (!message.content.toLowerCase().startsWith('w!') || message.author.bot) return;

    const args = message.content.slice(2).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    if (commands[commandName]) {
        try {
            await commands[commandName](message, args);
        } catch (error) {
            console.error('명령어 실행 오류:', error);
            message.reply('❌ 명령어 실행 중 오류가 발생했습니다.');
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    const cid    = interaction.customId;
    const userId = interaction.user.id;

    // ── 작품 녹화 시작 확인 버튼 ──────────────────────────────────
    if (cid === `confirm_start_artwork_${userId}`) {
        
        // 버튼을 누른 시점에 DB를 2차로 확인하여 이미 녹화가 시작된 경우 중복 시작 방지
        const existingArtwork = await RecordSession.findOne({
            userId, sessionType: 'artwork', isActive: true
        });
        if (existingArtwork) {
            pendingArtworkRecords.delete(userId); // 찌꺼기 정리
            return interaction.update({ 
                content: "❌ 이미 작품 타임랩스 녹화가 진행 중입니다. 기존 녹화를 먼저 중지해주세요.",
                embeds: [], components: [] 
            });
        }

        const recoveryPendingArtwork = await RecordSession.findOne({
            userId, sessionType: 'artwork', needsRecovery: true
        });
        if (recoveryPendingArtwork) {
            pendingArtworkRecords.delete(userId);
            return interaction.update({
                content:
                    `❌ 이전 작품 녹화(ID: \`${recoveryPendingArtwork.sessionId}\`)가 영상 생성 중 오류로 중단되어 복구 대기 중입니다.\n` +
                    `먼저 \`w!record recover ${recoveryPendingArtwork.sessionId}\` 명령어로 복구를 시도해주세요.`,
                embeds: [], components: []
            });
        }

        const pending = pendingArtworkRecords.get(userId);
        if (!pending) {
            return interaction.update({ content: "❌ 세션이 만료되었습니다. 다시 `w!record` 명령어를 실행해주세요.", embeds: [], components: [] });
        }
        pendingArtworkRecords.delete(userId);

        const { tileX, tileY, localX, localY, captureWidth, captureHeight } = pending;

        await new RecordSession({
            userId, sessionType: 'artwork',
            sessionId: generateSessionId(),
            tileX, tileY, localX, localY, captureWidth, captureHeight,
            isActive: true,
            commandChannelId: interaction.channelId
        }).save();

        // 최초 1번 프레임 즉시 저장
        try {
            const firstFrame = await captureRegionBuffer(tileX, tileY, localX, localY, captureWidth, captureHeight);
            await new RecordFrame({ userId, sessionType: 'artwork', frameData: firstFrame }).save();
            await RecordSession.updateOne({ userId, sessionType: 'artwork', isActive: true }, { frameCount: 1 });
        } catch (e) {
            console.error('첫 프레임 저장 오류:', e);
        }

        await interaction.update({
            content:
                "⏺️ **작품 타임랩스 녹화가 시작되었습니다!**\n\n" +
                "📌 **안내:**\n" +
                "• 30초마다 변화를 감지하여 프레임을 저장합니다.\n" +
                "• 변화가 없으면 해당 프레임은 자동으로 건너뜁니다.\n" +
                "• 최대 **2880 프레임** 도달 시 자동 종료됩니다.\n" +
                "• `w!record stop` 으로 현재 프레임 수 확인 및 중지 가능합니다.\n\n" +
                "녹화 완료 시 DM으로 MP4 타임랩스 영상을 전송해드립니다. 🎬",
            embeds: [], files: [], components: []
        });
        return;
    }

    if (cid === `cancel_start_artwork_${userId}`) {
    pendingArtworkRecords.delete(userId);
    await interaction.update({
        content: "❌ 녹화가 취소되었습니다.",
        embeds: [],
        files: [],
        attachments: [],
        components: []
    });
    return;
    }

    // ── 작품 녹화 중지 확인 ──────────────────────────────────────
    if (cid === `confirm_stop_artwork_${userId}`) {
        await interaction.update({ content: "⏹️ 녹화를 중지하고 영상을 생성합니다...", embeds: [], components: [] });
        // 이 메시지를 상태 메시지로 등록 → 이후 완료/오류 안내를 DM 대신 이 메시지 수정으로 전달
        await RecordSession.updateOne(
            { userId, sessionType: 'artwork', isActive: true },
            { isActive: false, statusChannelId: interaction.channelId, statusMessageId: interaction.message.id }
        );
        await finalizeRecord(userId, 'artwork');
        return;
    }

    // ── 두 개 동시 진행 → 선택 버튼 ─────────────────────────────
    if (cid === `stop_select_artwork_${userId}`) {
        const s = await RecordSession.findOne({ userId, sessionType: 'artwork', isActive: true });
        if (!s) return interaction.update({ content: "❌ 진행 중인 작품 녹화를 찾을 수 없습니다.", embeds: [], components: [] });
        const fc = s.frameCount || 0;
        const embed = new EmbedBuilder()
            .setTitle("🎨 작품 타임랩스 중단 확인")
            .setDescription(`현재까지 **${fc}/2880** 프레임 녹화됨.\n정말 중지하시겠습니까?`)
            .setColor(0xFFA500);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`confirm_stop_artwork_${userId}`).setLabel('✅ 중지').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`cancel_stop_record_${userId}`).setLabel('취소').setStyle(ButtonStyle.Secondary)
        );
        await interaction.update({ content: null, embeds: [embed], components: [row] });
        return;
    }

    if (cid === `stop_select_flag_${userId}`) {
        const s = await RecordSession.findOne({ userId, sessionType: 'flag', isActive: true });
        if (!s) return interaction.update({ content: "❌ 진행 중인 태극기 녹화를 찾을 수 없습니다.", embeds: [], components: [] });
        const fc = s.frameCount || 0;
        const embed = new EmbedBuilder()
            .setTitle("🚩 태극기 녹화 중단 확인")
            .setDescription(`현재까지 **${fc}** 프레임 녹화됨.\n정말 중지하시겠습니까?`)
            .setColor(0xFFA500);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirm_stop_record').setLabel('✅ 중지').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`cancel_stop_record_${userId}`).setLabel('취소').setStyle(ButtonStyle.Secondary)
        );
        await interaction.update({ content: null, embeds: [embed], components: [row] });
        return;
    }

    if (cid === `stop_select_cancel_${userId}`) {
        await interaction.update({ content: "⏺️ 녹화 계속 진행", embeds: [], components: [] });
        return;
    }

    // ── 기존 태극기 녹화 중지 확인 (하위 호환 유지) ──────────────
    if (cid === 'confirm_stop_record') {
        await interaction.update({ content: "✅ 녹화 중단됨", embeds: [], components: [] });
        // 이 메시지를 상태 메시지로 등록 → 이후 완료/오류 안내를 DM 대신 이 메시지 수정으로 전달
        await RecordSession.updateOne(
            { userId, sessionType: 'flag', isActive: true },
            { isActive: false, statusChannelId: interaction.channelId, statusMessageId: interaction.message.id }
        );
        await finalizeRecord(userId, 'flag');
        return;
    }

    if (cid === 'cancel_stop_record' || cid === `cancel_stop_record_${userId}`) {
        await interaction.update({ content: "⏺️ 녹화 계속 진행", embeds: [], components: [] });
        return;
    }
});

client.once('clientReady', () => {
    console.log(`✅ ${client.user.tag} 온라인! 감시 시스템 가동 중...`);
    console.log(`📡 ${client.guilds.cache.size}개 서버에서 활동 중`);
    cleanupOrphanedTempDirs();
    migrateLegacySessionIds();

    // Rich Presence 설정
    let statusIndex = 0;
    const statuses = [
        { name: '태극기 감시하는 중', type: 0 },
        { name: 'w!help로 도움말 열기', type: 0 }
    ];
    
    // 초기 상태 설정
    client.user.setPresence({
        activities: [statuses[0]],
        status: 'online'
    });
    
    // 30초마다 상태 교체
    setInterval(() => {
        statusIndex = (statusIndex + 1) % statuses.length;
        client.user.setPresence({
            activities: [statuses[statusIndex]],
            status: 'online'
        });
    }, 30000);  // 30초 = 30000ms
    
    // 30초마다 감시 수행
    setInterval(checkZones, 1000 * 30);
    setInterval(processRecordings, CAPTURE_INTERVAL_MS);
});

// 봇이 새 서버에 추가되었을 때
client.on('guildCreate', async (guild) => {
    console.log(`🔔 새 서버 초대 감지: ${guild.name} (ID: ${guild.id})`);
    
    // 화이트리스트 체크
    const isWhitelisted = await Whitelist.findOne({ guildId: guild.id });
    
    if (!isWhitelisted) {
        console.log(`🚫 화이트리스트에 없는 서버 감지: ${guild.name} (ID: ${guild.id})`);
        
        try {
            // 서버 소유자 정보
            const owner = await client.users.fetch(guild.ownerId).catch(() => null);
            const ownerTag = owner ? owner.tag : '알 수 없음';
            
            // 봇 초대자 정보 (audit log에서 확인 시도)
            let inviter = '알 수 없음';
            try {
                const auditLogs = await guild.fetchAuditLogs({
                    limit: 1,
                    type: 28 // BOT_ADD
                });
                const botAddLog = auditLogs.entries.first();
                if (botAddLog) {
                    inviter = botAddLog.executor.tag;
                }
            } catch (auditError) {
                console.log('초대자 정보 확인 실패:', auditError.message);
            }
            
            // 개발자에게 DM 알림
            if (DEVELOPER_ID) {
                try {
                    const developer = await client.users.fetch(DEVELOPER_ID);
                    
                    const alertEmbed = new EmbedBuilder()
                        .setTitle('⚠️ 화이트리스트 외 서버 초대 감지')
                        .setColor(0xFF0000)
                        .addFields(
                            { name: '서버 이름', value: guild.name, inline: true },
                            { name: '서버 ID', value: guild.id, inline: true },
                            { name: '멤버 수', value: `${guild.memberCount}명`, inline: true },
                            { name: '서버 소유자', value: ownerTag, inline: true },
                            { name: '봇 초대자', value: inviter, inline: true },
                            { name: '\u200B', value: '\u200B', inline: true },
                            { name: '조치', value: '서버에 안내 메시지를 보낸 후 자동 퇴장합니다.', inline: false },
                            { name: '승인 방법', value: `\`w!whitelist add ${guild.id}\``, inline: false }
                        )
                        .setTimestamp();
                    
                    await developer.send({ embeds: [alertEmbed] });
                } catch (dmError) {
                    console.error('개발자 DM 전송 실패:', dmError.message);
                }
            }
            
            // 서버에 메시지 전송
            const channel = guild.channels.cache.find(ch => 
                ch.isTextBased() && 
                ch.permissionsFor(guild.members.me).has('SendMessages') &&
                ch.permissionsFor(guild.members.me).has('EmbedLinks')
            );
            
            if (channel) {
                const noticeEmbed = new EmbedBuilder()
                    .setTitle('🚫 화이트리스트 미등록 서버')
                    .setDescription(
                        '이 서버는 화이트리스트에 등록되지 않은 서버입니다.\n\n' +
                        '**아래 서버에서 사용 승인을 받아주세요:**\n' +
                        'https://discord.gg/utxeK62GJV \n\n' +
                        '승인 후 다시 초대해주시면 정상적으로 사용하실 수 있습니다.'
                    )
                    .setColor(0xFF0000)
                    .addFields(
                        { name: '📋 승인 절차', value: '1. 지원 서버 참여\n2. 절차에 따라 승인 요청\n3. 승인 대기\n4. 봇 재초대', inline: false }
                    )
                    .setFooter({ text: '잠시 후 자동으로 서버에서 퇴장합니다.' })
                    .setTimestamp();
                
                await channel.send({ embeds: [noticeEmbed] });
                
                // 3초 후 퇴장 (메시지를 읽을 시간 제공)
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            
            // 서버에서 자동 퇴장
            await guild.leave();
            console.log(`📤 ${guild.name}에서 자동 퇴장 완료`);
            console.log(`   └ 소유자: ${ownerTag}`);
            console.log(`   └ 초대자: ${inviter}`);
            console.log(`   └ 멤버 수: ${guild.memberCount}명`);
            
        } catch (error) {
            console.error(`자동 퇴장 중 오류 발생 (${guild.name}):`, error);
        }
        
        return;
    }
    
    // 화이트리스트에 있는 서버 - 정상 처리
    console.log(`✅ 승인된 서버 추가됨: ${guild.name} (ID: ${guild.id})`);
    
    // 화이트리스트 정보 업데이트
    await Whitelist.findOneAndUpdate(
        { guildId: guild.id },
        { 
            guildName: guild.name,
            memberCount: guild.memberCount
        }
    );
});

// 봇이 서버에서 퇴장하거나 서버가 삭제되었을 때 실행
client.on('guildDelete', (guild) => {
    // 참고: guild 객체가 부분적(partial)일 수 있으므로 이름이 없을 경우를 대비합니다.
    const guildName = guild.name || '알 수 없는 서버';
    console.log(`📤 ${guildName}에서 퇴장함.`);
});

// ========================================
// 11. 봇 로그인
// ========================================
client.login(BOT_TOKEN)
    .then(() => console.log('🔐 디스코드 게이트웨이 접속 요청 성공'))
    .catch(error => {
        console.error('❌ 봇 로그인 실패:', error);
        // 치명적 오류 시 프로세스 종료 (Render가 재시작을 시도하게 함)
        process.exit(1);
    });