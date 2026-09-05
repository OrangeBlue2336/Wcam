const env = require('./config/env');
const {
    API_SECRET_KEY,
    MONGODB_URI,
    BOT_TOKEN,
    KOYEB_URL,
    PORT
} = env;
// CAPTURE_INTERVAL_MS, DEVELOPER_ID는 각각 events/clientReady.js, events/guildCreate.js가 직접 require

const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const sharp = require('sharp');
sharp.cache(false);
const mongoose = require('mongoose');
const path = require('path');
const { registerFont } = require('canvas');

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

// 2. MongoDB 연결 및 스키마 정의
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB 연결 성공!'))
    .catch(err => console.error('❌ MongoDB 연결 실패:', err));

// 3. Express 웹서버 (Keep-alive용)
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

// 4. 디스코드 봇 클라이언트 생성
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.setMaxListeners(15);

// 5. 감시 구역 설정
const monitorZones = require('./config/zones');

// checkZones/sendAlert와 공유 상태(zoneMatchData, zoneHistory, lastAlertTime)를 단일 인스턴스로 생성해 여러 파일이 함께 참조
const { checkZones, sendAlert, zoneMatchData, zoneHistory, lastAlertTime } = require('./services/monitor')(client);

// Express API 라우트 등록 (zoneMatchData, zoneHistory, monitorZones, client 준비된 뒤 연결)
require('./server/api')(app, { zoneMatchData, zoneHistory, monitorZones, client });

// 6. 유틸리티 함수 / 녹화 핵심 로직
// utils/helpers는 index.js에서 더 이상 쓰이지 않아 각 파일이 직접 require
// services/recording.js에서 index.js가 실제로 쓰는 것만 구조분해
const {
    captureRegionBuffer,
    finalizeRecord,
    cleanupRecord,
    migrateLegacySessionIds,
    processRecordings,
    pendingArtworkRecords
} = require('./services/recording')(client);

// 7. 명령어 시스템
// commandDeps: client·services 단일 인스턴스 등 명령어 파일들이 공유해야 하는 것들을 모아 주입
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

// commands/ 폴더의 모든 명령어(22개 + 별칭 f/h/r)를 자동으로 불러와 조립
const commands = require('./commands')(commandDeps);

// 10. 이벤트 핸들러
// messageCreate/interactionCreate/clientReady/guildCreate/guildDelete 본문은 events/*.js에 있고,
// 여기서는 각 파일이 필요로 하는 deps만 주입해서 등록
client.on('messageCreate', require('./events/messageCreate')(commands));

// interactionCreate: record.js와 같은 pendingArtworkRecords 인스턴스를 공유해야 버튼이 정상 동작
client.on('interactionCreate', require('./events/interactionCreate')({
    captureRegionBuffer,
    finalizeRecord,
    pendingArtworkRecords
}));

// clientReady: 감시/녹화 주기 작업(setInterval) 등록을 담당
client.once('clientReady', require('./events/clientReady')({
    client,
    checkZones,
    migrateLegacySessionIds,
    processRecordings
}));

// guildCreate: client만 주입, Whitelist·DEVELOPER_ID 등은 파일 내부에서 직접 require
client.on('guildCreate', require('./events/guildCreate')(client));

// guildDelete: 의존성이 없어 팩토리 호출 없이 바로 등록합니다.
client.on('guildDelete', require('./events/guildDelete'));

// 11. 봇 로그인
client.login(BOT_TOKEN)
    .then(() => console.log('🔐 디스코드 게이트웨이 접속 요청 성공'))
    .catch(error => {
        console.error('❌ 봇 로그인 실패:', error);
        // 치명적 오류 시 프로세스 종료
        process.exit(1);
    });