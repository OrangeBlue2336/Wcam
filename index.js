const env = require('./config/env');
const {
    API_SECRET_KEY,
    MONGODB_URI,
    BOT_TOKEN,
    KOYEB_URL,
    PORT
} = env;
// 9단계: CAPTURE_INTERVAL_MS는 events/clientReady.js가, DEVELOPER_ID는 events/guildCreate.js가
// 각자 config/env에서 직접 불러와 사용하므로 index.js에서는 더 이상 구조분해하지 않습니다.

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
// 9단계: index.js가 직접 쓰던 utils/helpers 함수(generateSessionId, findZone,
// cleanupOrphanedTempDirs, getZoneSetting)는 모두 events/*.js로 옮겨졌고, 각 파일이
// 필요한 것을 직접 require합니다. index.js 자체에서는 더 이상 이 모듈이 필요 없습니다.

// 녹화 핵심 로직(services/recording.js)에서 가져오는 함수/상태 중,
// index.js(commandDeps, events)가 실제로 사용하는 것만 구조분해합니다.
// captureAndSave, updateStatusMessage, createStatusMessageAndFinalize, processEncodeQueue,
// performFinalizeRecord, encodeQueue는 services/recording.js 내부에서만 쓰이고
// index.js에서는 쓰인 적이 없어(=원래도 죽은 구조분해였음) 이번 정리에서 함께 제거했습니다.
// client가 이미 만들어져 있는 시점(섹션 4 이후)이라 여기서 바로 불러옵니다.
const {
    captureRegionBuffer,
    finalizeRecord,
    cleanupRecord,
    migrateLegacySessionIds,
    processRecordings,
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
// 9단계: messageCreate, interactionCreate, clientReady, guildCreate, guildDelete
// 5개 이벤트 핸들러 본문을 모두 events/*.js로 옮겼습니다. index.js에는 각 파일에
// 필요한 deps를 주입해서 등록하는 코드만 남습니다.
//
// - messageCreate: commands 객체만 있으면 되므로 그대로 전달합니다.
// - interactionCreate: services/recording.js의 단일 인스턴스(captureRegionBuffer,
//   finalizeRecord, pendingArtworkRecords)를 commandDeps와 동일하게 전달해서,
//   record.js가 만든 대기 세션을 버튼 클릭 시 그대로 찾을 수 있도록 합니다.
// - clientReady: services/monitor.js의 checkZones, services/recording.js의
//   migrateLegacySessionIds/processRecordings 단일 인스턴스와 client를 전달합니다.
// - guildCreate: client만 주입받고 나머지(Whitelist, DEVELOPER_ID 등)는 파일 내부에서
//   직접 require합니다.
// - guildDelete: 의존성이 없어 팩토리 호출 없이 바로 등록합니다.
client.on('messageCreate', require('./events/messageCreate')(commands));

client.on('interactionCreate', require('./events/interactionCreate')({
    captureRegionBuffer,
    finalizeRecord,
    pendingArtworkRecords
}));

client.once('clientReady', require('./events/clientReady')({
    client,
    checkZones,
    migrateLegacySessionIds,
    processRecordings
}));

client.on('guildCreate', require('./events/guildCreate')(client));

client.on('guildDelete', require('./events/guildDelete'));

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