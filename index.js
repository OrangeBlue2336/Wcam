const env = require('./config/env');
const {
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
// record.js(7-3단계, v4)는 services/recording.js의 captureRegionBuffer/finalizeRecord/
// cleanupRecord/pendingArtworkRecords를 추가로 필요로 합니다. 이 함수들은 위에서
// require('./services/recording')(client)로 "한 번만" 생성된 것을 그대로 주입해야
// interactionCreate(버튼 처리, 아직 index.js에 있음)와 같은 상태(pendingArtworkRecords 등)를
// 공유할 수 있습니다. record.js 안에서 다시 require하면 상태가 분리되어 버튼이 오작동합니다.
const commandDeps = {
    client,
    sendAlert,
    lastAlertTime,
    captureRegionBuffer,
    finalizeRecord,
    cleanupRecord,
    pendingArtworkRecords
};
const extractedCommands = require('./commands')(commandDeps);

const commands = {
    ...extractedCommands,
    // 아래는 아직 옮기지 않은 명령어입니다 (7-3 단계 마지막 1개: history).
    // status / flag / updatenotif / servers / leaveserver / whitelist / record 는 commands/ 폴더로 이동 완료.

   'f': async (message, args) => commands['flag'](message, args),

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