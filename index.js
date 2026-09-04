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
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const sharp = require('sharp');
sharp.cache(false);
const mongoose = require('mongoose');
const path = require('path');
const { registerFont } = require('canvas');
const { Whitelist, RecordSession, RecordFrame } = require('./db/models');

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

// ========================================
// 3. Express 웹서버 (Keep-alive용)
// ========================================
const app = express();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 서버가 포트 ${PORT}에서 실행 중입니다`);
    console.log(`📡 Public URL: ${KOYEB_URL}`);
});

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

// 8단계: 감시(checkZones)·알림(sendAlert) 서비스와 그 공유 상태
// (zoneMatchData, zoneHistory, lastAlertTime)를 client 준비된 뒤 "한 번만" 생성합니다.
// server/api.js, commands/history.js, commands/resetcooldown.js, commands/testalert.js가
// 모두 이 하나의 인스턴스를 deps로 전달받아 같은 데이터를 바라보게 됩니다.
const { checkZones, sendAlert, zoneMatchData, zoneHistory, lastAlertTime } = require('./services/monitor')(client);

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
// commandDeps: 아직 index.js에만 있는(또는 client처럼 index.js에서만 만들 수 있는) 것들을
// 모아서 모든 명령어 파일에 주입합니다.
// - client: discord.js 클라이언트
// - sendAlert, lastAlertTime, zoneHistory: services/monitor.js에서 만든 단일 인스턴스
//   (checkZones()가 기록한 데이터를 명령어들이 그대로 읽고/쓸 수 있어야 하므로)
// - captureRegionBuffer, finalizeRecord, cleanupRecord, pendingArtworkRecords:
//   services/recording.js에서 만든 단일 인스턴스 (버튼 처리 로직과 상태를 공유해야 하므로)
const commandDeps = {
    client,
    sendAlert,
    lastAlertTime,
    zoneHistory,
    captureRegionBuffer,
    finalizeRecord,
    cleanupRecord,
    pendingArtworkRecords
};

// 7-3단계까지 모든 명령어(22개 + 별칭 f/h/r)가 commands/ 폴더로 이동 완료되어,
// 더 이상 index.js 안에 남아있는 명령어가 없습니다. 한 줄로 조립이 끝납니다.
const commands = require('./commands')(commandDeps);

// ========================================
// 8. 핵심 감시 로직 / 9. 알림 전송 함수
// ========================================
// checkZones(), sendAlert()와 그 공유 상태(zoneMatchData, zoneHistory, lastAlertTime)는
// services/monitor.js로 이동했습니다 (8단계). 위에서 이미 구조분해해온
// checkZones를 아래 setInterval에서 그대로 사용합니다.

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