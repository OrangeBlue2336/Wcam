require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const sharp = require('sharp');
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const { PNG } = require('pngjs');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const mongoose = require('mongoose');
const path = require('path');
const { registerFont, createCanvas, loadImage } = require('canvas');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

// ========================================
// 전역 설정 및 상수
// ========================================
const RECORD_FPS = 30; // 수정이 용이하도록 상단에 배치
const MAX_RECORD_DURATION_MS = 24 * 60 * 60 * 1000; // 최대 24시간
const CAPTURE_INTERVAL_MS = 30000; // 30초마다 캡처 (기존 감시 주기와 동일하게 설정)

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
// API 보안 설정
// ========================================
const API_SECRET_KEY = process.env.API_SECRET_KEY || '';

// API 키 검증 미들웨어
function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    // API 키가 없거나 일치하지 않으면 차단
    if (!apiKey || apiKey !== API_SECRET_KEY) {
        console.log(`🚫 무단 API 접근 시도: IP=${req.ip}, Key=${apiKey ? '잘못된 키' : '키 없음'}`);
        return res.status(401).json({ 
            success: false, 
            error: 'Unauthorized access' 
        });
    }
    
    next();
}

// ========================================
// 1. 환경 변수 설정 (Render에서 설정할 것들)
// ========================================
const MONGODB_URI = process.env.MONGODB_URI || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const KOYEB_URL = process.env.KOYEB_PUBLIC_DOMAIN
    ? `https://${process.env.KOYEB_PUBLIC_DOMAIN}`
    : '';
const NODE_ENV = process.env.NODE_ENV || 'production';
const DEVELOPER_ID = process.env.DEVELOPER_ID || '' ;
const SUPPORT_SERVER_URL = process.env.SUPPORT_SERVER_URL || 'https://discord.gg/utxeK62GJV';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://wplacebackend.github.io';


// 개발 모드 확인
const IS_DEV = NODE_ENV === 'development';
if (IS_DEV) {
    console.log('🔧 개발 모드로 실행 중...');
} else {
    console.log('🚀 프로덕션 모드로 실행 중...');
}

// 환경변수 확인 (보안상 전체는 표시하지 않음)
if (!MONGODB_URI || !BOT_TOKEN) {
    console.error('❌ 필수 환경변수가 설정되지 않았습니다!');
    console.error('MONGODB_URI:', MONGODB_URI ? '✅ 설정됨' : '❌ 없음');
    console.error('BOT_TOKEN:', BOT_TOKEN ? '✅ 설정됨' : '❌ 없음');
    process.exit(1);
}

// ========================================
// 2. MongoDB 연결 및 스키마 정의
// ========================================
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB 연결 성공!'))
    .catch(err => console.error('❌ MongoDB 연결 실패:', err));

// 서버별 설정을 저장하는 스키마
const SettingSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    cooldownTime: { type: Number, default: 600000 }, // 전역 쿨다운
    enabled: { type: Boolean, default: true }, // 전역 활성화 상태
    
    // 전역 기본 설정 (구역별 설정이 없을 때 사용)
    defaultChannelId: String,
    defaultRoleId: String,
    defaultThreshold: { type: Number, default: 90 },
    
    // 구역별 개별 설정
    zones: {
        type: Map,
        of: new mongoose.Schema({
            channelId: String,
            roleId: String,
            threshold: Number,
            enabled: { type: Boolean, default: true } // 구역별 활성화 상태
        }, { _id: false }),
        default: {}
    }
});

const Setting = mongoose.model('Setting', SettingSchema);

// ✅ 화이트리스트 스키마 추가
const WhitelistSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    guildName: String,
    addedBy: String,
    addedAt: { type: Date, default: Date.now },
    ownerTag: String,
    memberCount: Number
});

const Whitelist = mongoose.model('Whitelist', WhitelistSchema);

// 마지막 알림 시간을 메모리에 저장 (서버별, 구역별)
const lastAlertTime = {}; // 형식: { "guildId-zoneName": timestamp }

// 녹화 세션 정보 (누가, 어디를, 언제까지 녹화하는지)
const RecordSessionSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    zoneName: String,
    startTime: { type: Date, default: Date.now },
    endTime: Date,
    isActive: { type: Boolean, default: true }
});
const RecordSession = mongoose.model('RecordSession', RecordSessionSchema);

// 녹화 프레임 데이터 (이미지 바이너리 저장)
const RecordFrameSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    frameData: Buffer,
    timestamp: { type: Date, default: Date.now }
});
const RecordFrame = mongoose.model('RecordFrame', RecordFrameSchema);

// ========================================
// 3. Express 웹서버 (Keep-alive용)
// ========================================
const app = express();
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 서버가 포트 ${PORT}에서 실행 중입니다`);
    console.log(`📡 Public URL: ${KOYEB_URL}`);
});

app.get('/', (req, res) => res.send('Wcam Bot is Running!'));

// ✅ 새로운 API 엔드포인트 추가
// 봇 상태 확인 API
app.get('/api/status', validateApiKey, (req, res) => {
    res.json({
        online: true,
        totalServers: client.guilds.cache.size,
        totalZones: monitorZones.length,
        uptime: process.uptime()
    });
});

// 구역별 실시간 데이터 API
const zoneMatchData = {}; // 전역 변수로 일치율 저장

app.get('/api/zones', validateApiKey, async (req, res) => {
    try {
        const zonesData = await Promise.all(monitorZones.map(async (zone, index) => {
            // 현재 저장된 일치율 가져오기 (없으면 null)
            const matchData = zoneMatchData[zone.name] || null;
            
            return {
                name: zone.name,
                tileUrl: zone.tileUrl,
                wplaceUrl: zone.wplaceUrl,
                matchPercentage: matchData ? matchData.percentage : null,
                lastChecked: matchData ? matchData.timestamp : null,
                threshold: 90,
                totalPixels: matchData ? matchData.totalPixels : null,
                matchPixels: matchData ? matchData.matchPixels : null,
                diffPixels: matchData ? matchData.diffPixels : null
            };
        }));
        
        res.json({
            success: true,
            zones: zonesData,
            lastUpdate: new Date().toISOString()
        });
    } catch (error) {
        console.error('API 오류:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 특정 구역의 최신 이미지 가져오기
app.get('/api/zone/:zoneName/image', validateApiKey, async (req, res) => {
    try {
        const zoneName = req.params.zoneName;
        const zone = monitorZones.find(z => z.name === zoneName);
        
        if (!zone) {
            return res.status(404).json({ success: false, error: '구역을 찾을 수 없습니다' });
        }
        
        // 실시간 이미지 가져오기
        const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
        const currentFlagBuffer = await sharp(Buffer.from(response.data))
            .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
            .toBuffer();
        
        res.set('Content-Type', 'image/png');
        res.send(currentFlagBuffer);
    } catch (error) {
        console.error('이미지 로드 오류:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 일치율 히스토리 API (차트용)
const zoneHistory = {}; // 구역별 히스토리 저장

app.get('/api/zone/:zoneName/history', validateApiKey, (req, res) => {
    const zoneName = req.params.zoneName;
    const history = zoneHistory[zoneName] || [];
    
    res.json({
        success: true,
        zoneName: zoneName,
        history: history.slice(-60) // 최근 60개만 반환
    });
});

app.use(express.static('public')); // public 폴더에 HTML 파일 넣기

// app.listen(process.env.PORT || 3000, () => console.log('🌐 Keep-alive 서버 실행 중'));

// 10분마다 자기 자신에게 요청 보내기 (Render 무료 플랜 슬립 방지)
// setInterval(() => {
//    axios.get(RENDER_URL).catch(err => console.log('Keep-alive 오류:', err.message));
// }, 1000 * 60 * 10);

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
const monitorZones = [
    {
        name: "독도 태극기",
        tileUrl: "https://backend.wplace.live/tile/1774/795.png",
        originalPath: "./assets/ref_dokdo.png",
        x: 40, y: 100, width: 361, height: 261,
        wplaceUrl: "https://wplace.live/?lat=37.26901731348799&lng=131.8750484967773&zoom=12.532754498466533"
    },
    {
        name: "서울 태극기",
        tileUrl: "https://backend.wplace.live/tile/1746/793.png",
        originalPath: "./assets/ref_seoul.png",
        x: 420, y: 691, width: 160, height: 120,
        wplaceUrl: "https://wplace.live/?lat=37.47464909223321&lng=127.00204068427732&zoom=13.744052003011783"
    },
    {
        name: "백두산 태극기",
        tileUrl: "https://backend.wplace.live/tile/1752/760.png",
        originalPath: "./assets/ref_baekdu.png",
        x: 374, y: 111, width: 204, height: 159,
        wplaceUrl: "https://wplace.live/?lat=42.00718311351218&lng=128.05373990302732&zoom=13.726827756600123"
    }
];

// ========================================
// 6. 유틸리티 함수
// ========================================
function parseDuration(duration) {
    const match = duration.match(/^(\d+)([smh])$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 1000 * 60;
        case 'h': return value * 1000 * 60 * 60;
        default: return null;
    }
}

// 영문 시간 표기를 한국어로 변환하는 함수
function durationToKorean(duration) {
    const match = duration.match(/^(\d+)([smh])$/);
    if (!match) return duration;
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
        case 's': return `${value}초`;
        case 'm': return `${value}분`;
        case 'h': return `${value}시간`;
        default: return duration;
    }
}

// 구역 이름으로 구역 객체 찾기
function findZone(zoneName) {
    if (!zoneName) return null;
    const normalized = zoneName.toLowerCase().trim();
    return monitorZones.find(z => 
        z.name.toLowerCase().includes(normalized) ||
        normalized.includes(z.name.toLowerCase())
    );
}

// 시작 시 남아있는 오래된 임시 폴더 정리 함수
function cleanupOrphanedTempDirs() {
    const tmpDirBase = os.tmpdir();
    fs.readdir(tmpDirBase, (err, files) => {
        if (err) return console.error('임시 폴더 읽기 실패:', err);
        
        files.forEach(file => {
            if (file.startsWith('record_')) {
                const fullPath = path.join(tmpDirBase, file);
                try {
                    const stats = fs.statSync(fullPath);
                    // 폴더가 생성된 지 6시간이 지났다면 삭제
                    if (Date.now() - stats.mtimeMs > 21600000) {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                        console.log(`🧹 고아 임시 폴더 삭제됨: ${fullPath}`);
                    }
                } catch (e) {
                    console.error(`임시 폴더 삭제 실패: ${fullPath}`, e);
                }
            }
        });
    });
}

// 설정에서 구역별 값 가져오기 (구역 설정 > 전역 기본값 우선순위)
function getZoneSetting(setting, zoneName, key) {
    if (!setting) return null;
    
    // 구역별 설정이 있으면 우선 사용
    if (setting.zones && setting.zones.has(zoneName)) {
        const zoneConfig = setting.zones.get(zoneName);
        if (zoneConfig[key] !== undefined && zoneConfig[key] !== null) {
            return zoneConfig[key];
        }
    }
    
    // 구역별 설정이 없으면 전역 기본값 사용
    const defaultKey = `default${key.charAt(0).toUpperCase() + key.slice(1)}`;
    return setting[defaultKey];
}

// 캡처 및 저장 함수
async function captureAndSave(session) {
    try {
        const zone = monitorZones.find(z => z.name === session.zoneName);
        if (!zone) return;

        const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
        const frameBuffer = await sharp(Buffer.from(response.data))
            .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
            .toBuffer();

        await new RecordFrame({
            userId: session.userId,
            frameData: frameBuffer
        }).save();
        
        console.log(`📸 녹화 ${session.userId} - ${session.zoneName} 프레임 저장됨`);
    } catch (error) {
        console.error(`❌ 녹화 오류 ${session.userId}:`, error.message);
    }
}

async function finalizeRecord(userId) {
    const session = await RecordSession.findOne({ userId });
    if (!session) return;

    // 임시 작업 디렉토리 생성
    const tmpDir = path.join(os.tmpdir(), `record_${userId}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        const totalFrames = await RecordFrame.countDocuments({ userId });
        const user = await client.users.fetch(userId);

        if (totalFrames === 0) {
            await user.send("⚠️ 녹화된 프레임이 없어 영상을 생성할 수 없습니다.");
            await cleanupRecord(userId);
            return;
        }

        console.log(`🎞️ [MP4 생성 시작] ${userId} - 총 ${totalFrames}프레임`);
        await user.send(`⏳ **${session.zoneName}** 영상 생성을 시작합니다. (총 ${totalFrames}프레임)\n프레임 수가 많을 경우 시간이 걸릴 수 있습니다.`);

        // 프레임을 50개씩 꺼내서 임시 폴더에 PNG 파일로 저장
        const frameIds = await RecordFrame.find({ userId })
            .sort({ timestamp: 1 })
            .select('_id')
            .lean();

        const CHUNK_SIZE = 50;
        let frameIndex = 0;

        for (let i = 0; i < frameIds.length; i += CHUNK_SIZE) {
            const chunkIds = frameIds.slice(i, i + CHUNK_SIZE).map(f => f._id);
            const chunk = await RecordFrame.find({ _id: { $in: chunkIds } })
                .sort({ timestamp: 1 })
                .lean();

            for (const frame of chunk) {
                // %05d 형식으로 파일명 지정 (ffmpeg가 순서대로 읽기 위함)
                const framePath = path.join(tmpDir, `frame_${String(frameIndex).padStart(5, '0')}.png`);
                fs.writeFileSync(framePath, Buffer.from(frame.frameData.buffer || frame.frameData));
                frame.frameData = null; // 즉시 메모리 해제
                frameIndex++;
            }

            console.log(`📁 [프레임 저장] ${userId} - ${frameIndex}/${totalFrames}`);
        }

        // ffmpeg로 MP4 인코딩 (디스크에서 읽어서 디스크에 씀 → 메모리 거의 안 씀)
        const outputPath = path.join(tmpDir, 'output.mp4');
        const inputPattern = path.join(tmpDir, 'frame_%05d.png');

        await new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', [
                '-framerate', String(RECORD_FPS),
                '-i', inputPattern,
                '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', // 가로/세로가 홀수인 경우 짝수로 패딩
                '-c:v', 'libx264',       // H.264 코덱
                '-pix_fmt', 'yuv420p',   // 호환성 최대화
                '-preset', 'fast',        // 인코딩 속도/압축 균형
                '-crf', '17',            // 화질 (낮을수록 좋음, 18~28 권장)
                outputPath
            ]);

            ffmpeg.stderr.on('data', (data) => {
                console.log(`ffmpeg: ${data}`);
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg 종료 코드: ${code}`));
            });
        });

        console.log(`✅ [MP4 인코딩 완료] ${userId}`);

        // Discord 파일 크기 제한 확인 (무료: 25MB)
        const stats = fs.statSync(outputPath);
        const fileSizeMB = stats.size / (1024 * 1024);

        if (fileSizeMB > 24) {
            console.log(`⚠️ [MP4 용량 초과] ${userId} - ${fileSizeMB.toFixed(1)}MB. 재압축 시도.`);
            await user.send(`⚠️ 영상 용량이 커서(${fileSizeMB.toFixed(1)}MB) 전송 한도를 초과했습니다. 화질을 낮춰 재압축을 시도합니다. 잠시만 기다려주세요...`);

            const compressedOutputPath = path.join(tmpDir, 'output_compressed.mp4');

            // CRF 값을 26으로 높여서(화질 감소, 용량 대폭 감소) 재압축
            await new Promise((resolve, reject) => {
                const reEncode = spawn('ffmpeg', [
                    '-i', outputPath,
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '26', // 화질을 더 낮춰서 용량을 더 줄임
                    compressedOutputPath
                ]);

                reEncode.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`재압축 ffmpeg 종료 코드: ${code}`));
                });
            });

            const newStats = fs.statSync(compressedOutputPath);
            const newFileSizeMB = newStats.size / (1024 * 1024);

            if (newFileSizeMB > 24) {
                // 재압축 후에도 24MB를 넘으면 최종 포기
                await user.send(
                    `❌ 재압축을 진행했으나 파일이 여전히 너무 큽니다(${newFileSizeMB.toFixed(1)}MB).\n` +
                    `녹화 시간을 조금 더 짧게 설정해주세요.`
                );
            } else {
                // 재압축 성공 시 전송
                const attachment = new AttachmentBuilder(compressedOutputPath, { name: `record_${session.zoneName}_compressed.mp4` });
                await user.send({
                    content: `✅ **${session.zoneName}** 녹화가 완료되었습니다! (압축됨, ${newFileSizeMB.toFixed(1)}MB)`,
                    files: [attachment]
                });
                console.log(`✅ [MP4 재압축 전송 완료] ${userId}`);
            }
        } else {
            // 원본이 24MB 이하일 경우 정상 전송 (기존 로직)
            const attachment = new AttachmentBuilder(outputPath, { name: `record_${session.zoneName}.mp4` });
            await user.send({
                content: `✅ **${session.zoneName}** 녹화가 완료되었습니다! (총 ${totalFrames}프레임, ${fileSizeMB.toFixed(1)}MB)`,
                files: [attachment]
            });
            console.log(`✅ [MP4 전송 완료] ${userId}`);
        }

    } catch (error) {
        console.error(`❌ [MP4 생성 오류] ${userId}:`, error);
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await user.send("❌ 영상 생성 중 오류가 발생했습니다.");
    } finally {
        // 임시 파일 전부 삭제
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
            console.error('임시 파일 삭제 실패:', e);
        }
        await cleanupRecord(userId);
    }
}

async function cleanupRecord(userId) {
    await RecordSession.deleteOne({ userId });
    await RecordFrame.deleteMany({ userId });
}

async function processRecordings() {
    const now = new Date();
    const activeSessions = await RecordSession.find({ isActive: true });

    for (const session of activeSessions) {
        if (now >= session.endTime) {
            await RecordSession.updateOne({ userId: session.userId }, { isActive: false });
            finalizeRecord(session.userId);
            continue;
        }
        await captureAndSave(session);
    }
}

// ========================================
// 7. 명령어 시스템
// ========================================
const commands = {
    'ping': async (message) => {
        const sent = await message.reply('퐁! 측정 중...');
        sent.edit(`퐁! 지연 시간: ${sent.createdTimestamp - message.createdTimestamp}ms`);
    },

    'setchannel': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }
        // 인자가 없는 경우
    if (args.length === 0) {
        return message.reply('❌ 사용법: `w!setchannel [구역] #채널` 또는 `w!setchannel #채널` (전체 적용)');
    }
    
    let zoneName = null;
    let channelId = null;
    
    // 경우 1: w!setchannel #채널 (전체 적용)
    if (args.length === 1) {
        channelId = args[0].replace(/[<#>]/g, '');
    }
    // 경우 2: w!setchannel 독도 #채널 (특정 구역)
    else if (args.length >= 2) {
        // 마지막 인자가 채널
        channelId = args[args.length - 1].replace(/[<#>]/g, '');
        // 나머지가 구역 이름
        zoneName = args.slice(0, -1).join(' ');
        
        // 구역 유효성 검사
        const zone = findZone(zoneName);
        if (!zone) {
            return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다. 사용 가능한 구역: ${monitorZones.map(z => z.name).join(', ')}`);
        }
        zoneName = zone.name; // 정확한 이름으로 통일
    }
    
    // 채널 유효성 검사
    const channel = message.guild.channels.cache.get(channelId);
    if (!channel) {
        return message.reply('❌ 해당 채널을 찾을 수 없습니다. 올바른 채널을 입력해주세요.');
    }
    if (!channel.isTextBased()) {
        return message.reply('❌ 텍스트 채널만 설정할 수 있습니다.');
    }
    
    // DB 업데이트
    if (zoneName) {
        // 특정 구역에만 적용
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { $set: { [`zones.${zoneName}.channelId`]: channelId } },
            { upsert: true }
        );
        message.reply(`✅ **${zoneName}** 구역의 알림 채널이 <#${channelId}>(으)로 설정되었습니다.`);
    } else {
        // 전체 기본값으로 적용
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { defaultChannelId: channelId },
            { upsert: true }
        );
        message.reply(`✅ 모든 구역의 기본 알림 채널이 <#${channelId}>(으)로 설정되었습니다.\n(개별 구역 설정이 없는 경우 이 채널이 사용됩니다)`);
    }
},

    'setrole': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }
        if (args.length === 0) {
        return message.reply('❌ 사용법: `w!setrole [구역] @역할` 또는 `w!setrole @역할` (전체 적용)');
    }
    
    let zoneName = null;
    let roleId = null;
    
    // 경우 1: w!setrole @역할 (전체 적용)
    if (args.length === 1) {
        roleId = args[0].replace(/[<@&>]/g, '');
    }
    // 경우 2: w!setrole 독도 @역할 (특정 구역)
    else if (args.length >= 2) {
        roleId = args[args.length - 1].replace(/[<@&>]/g, '');
        zoneName = args.slice(0, -1).join(' ');
        
        const zone = findZone(zoneName);
        if (!zone) {
            return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);
        }
        zoneName = zone.name;
    }
    
    // 역할 유효성 검사
    const role = message.guild.roles.cache.get(roleId);
    if (!role) {
        return message.reply('❌ 해당 역할을 찾을 수 없습니다.');
    }
    
    // DB 업데이트
    if (zoneName) {
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { $set: { [`zones.${zoneName}.roleId`]: roleId } },
            { upsert: true }
        );
        message.reply(`✅ **${zoneName}** 구역의 알림 역할이 ${role.name}(으)로 설정되었습니다.`);
    } else {
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { defaultRoleId: roleId },
            { upsert: true }
        );
        message.reply(`✅ 모든 구역의 기본 알림 역할이 ${role.name}(으)로 설정되었습니다.`);
    }
},

    'setcooldown': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }

        if (!args[0]) {
            return message.reply('❌ 시간을 입력해주세요. (예: 10m, 1h, 30s)');
        }
    
        const duration = args[0];
        const ms = parseDuration(duration);
        if (!ms) return message.reply('❌ 시간 형식 오류입니다. (예: 10m, 1h, 30s)');

        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { cooldownTime: ms },
            { upsert: true }
        );

        message.reply(`✅ 알림 쿨다운이 ${durationToKorean(duration)}(으)로 설정되었습니다.`);
    },

    'setthreshold': async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }

    if (args.length === 0) {
        return message.reply('❌ 사용법: `w!setthreshold [구역] 값` 또는 `w!setthreshold 값` (전체 적용)\n예: `w!setthreshold 85` 또는 `w!setthreshold 독도 88`');
    }
    
    let zoneName = null;
    let thresholdValue = null;
    
    // 경우 1: w!setthreshold 85 (전체 적용)
    if (args.length === 1) {
        thresholdValue = parseFloat(args[0]);
    }
    // 경우 2: w!setthreshold 독도 88 (특정 구역)
    else if (args.length >= 2) {
        thresholdValue = parseFloat(args[args.length - 1]);
        zoneName = args.slice(0, -1).join(' ');
        
        const zone = findZone(zoneName);
        if (!zone) {
            return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);
        }
        zoneName = zone.name;
    }
    
    // 숫자 유효성 검사
    if (isNaN(thresholdValue)) {
        return message.reply('❌ 올바른 숫자를 입력해주세요. (예: w!setthreshold 85)');
    }
    
    // 범위 검사 (0~100)
    if (thresholdValue < 0 || thresholdValue > 100) {
        return message.reply('❌ 임계값은 0에서 100 사이의 값이어야 합니다.');
    }
    
    // DB 업데이트
    if (zoneName) {
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { $set: { [`zones.${zoneName}.threshold`]: thresholdValue } },
            { upsert: true }
        );
        message.reply(`✅ **${zoneName}**의 훼손 감지 임계값이 **${thresholdValue}%**로 설정되었습니다.`);
    } else {
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { defaultThreshold: thresholdValue },
            { upsert: true }
        );
        message.reply(`✅ 모든 구역의 기본 임계값이 **${thresholdValue}%**로 설정되었습니다.\n(개별 구역 설정이 없는 경우 이 값이 사용됩니다)`);
    }
},

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
            const embed = new EmbedBuilder()
                .setTitle(`🖼️ 실시간 감시 화면: ${zone.name}`)
                .setURL(zone.wplaceUrl)
                .addFields(
                    { name: '현재 일치율', value: `**${matchPercentage.toFixed(2)}%**`, inline: true },
                    { name: '감시 기준', value: `${serverThreshold}%`, inline: true },
                    { name: '픽셀 정보', value: `일치: ${matchPixels.toLocaleString()}/${totalPixels.toLocaleString()}\n불일치: ${numDiffPixels.toLocaleString()}개`, inline: false }
                )
                .setDescription(
                    matchPercentage < serverThreshold
                        ? "⚠️ **주의: 현재 태극기가 훼손되었을 가능성이 있습니다!**"
                        : "✅ 현재 일치율이 임계값 이상입니다."
                )
                .setColor(matchPercentage < serverThreshold ? 0xFF0000 : 0x00FF00)
                .setImage('attachment://current_flag.png')
                .setTimestamp();

            await statusMsg.delete();
            message.channel.send({ embeds: [embed], files: [attachment] });
        } catch (error) {
            console.error(error);
            message.reply('❌ 이미지 분석 중 오류가 발생했습니다.');
        }
    },

    'testalert': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }

        // silent 옵션 확인
        const isSilent = args.includes('silent');

        // silent 제거 후 구역 이름 추출
        const zoneNameArgs = args.filter(arg => arg.toLowerCase() !== 'silent');
        const zoneName = zoneNameArgs.join(' ') || "독도 태극기";
    
        const zone = findZone(zoneName);
        if (!zone) return message.reply('❌ 테스트할 구역을 찾을 수 없습니다.');

        const silentText = isSilent ? ' (조용한 모드)' : '';
        message.reply(`🔔 [테스트] ${zone.name} 구역의 강제 알림 테스트를 시작합니다...${silentText}`);

        try {
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            const currentFlagBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .toBuffer();

            const testTotalPixels = zone.width * zone.height;
            const setting = await Setting.findOne({ guildId: message.guild.id });

            const channelId = getZoneSetting(setting, zone.name, 'channelId');
            const roleId = getZoneSetting(setting, zone.name, 'roleId');
            const serverThreshold = getZoneSetting(setting, zone.name, 'threshold') || 90;
        
          await sendAlert(
            zone, 
            0.00, 
            currentFlagBuffer, 
            message.guild.id, 
            0, 
            testTotalPixels, 
            testTotalPixels, 
            serverThreshold,
            channelId,
            roleId,
            isSilent
        );
        const resultText = isSilent 
            ? '✅ 테스트 알림이 전송되었습니다. (역할 멘션 없음)'
            : '✅ 테스트 알림이 전송되었습니다. (역할 멘션 포함)';
        message.channel.send(resultText);
    } catch (error) {
        console.error(error);
        message.reply('❌ 테스트 알림 전송 중 오류가 발생했습니다.');
    }
},

    'resetcooldown': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }

        const zoneName = args.join(' ');
        if (!zoneName) {
            // 해당 서버의 모든 구역 쿨다운 초기화
            for (const key in lastAlertTime) {
                if (key.startsWith(message.guild.id)) {
                    delete lastAlertTime[key];
                }
            }
            return message.reply('✅ 이 서버의 모든 구역 알림 쿨다운이 초기화되었습니다.');
        }

        const zone = findZone(zoneName);
        if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

        delete lastAlertTime[`${message.guild.id}-${zone.name}`];
        message.reply(`✅ ${zone.name}의 알림 쿨다운이 초기화되었습니다.`);
    },

    'disablezone': async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    
    const zoneName = args.join(' ');
    if (!zoneName) {
        return message.reply('❌ 비활성화할 구역을 입력해주세요.\n예: `w!disablezone 독도`');
    }
    
    const zone = findZone(zoneName);
    if (!zone) {
        return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.\n사용 가능한 구역: ${monitorZones.map(z => z.name).join(', ')}`);
    }
    
    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { $set: { [`zones.${zone.name}.enabled`]: false } },
        { upsert: true }
    );
    
    message.reply(`⏸️ **${zone.name}** 구역의 감시가 비활성화되었습니다.\n재활성화하려면 \`w!enablezone ${zone.name}\`을 입력하세요.`);
},

'enablezone': async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    
    const zoneName = args.join(' ');
    if (!zoneName) {
        return message.reply('❌ 활성화할 구역을 입력해주세요.\n예: `w!enablezone 독도`');
    }
    
    const zone = findZone(zoneName);
    if (!zone) {
        return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.\n사용 가능한 구역: ${monitorZones.map(z => z.name).join(', ')}`);
    }
    
    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { $set: { [`zones.${zone.name}.enabled`]: true } },
        { upsert: true }
    );
    
    message.reply(`✅ **${zone.name}** 구역의 감시가 활성화되었습니다.`);
},

    'help': async (message) => {
    // 페이지별 컨텐츠 정의
    const pages = [
        // 페이지 1: 기본 명령어
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (1/4)')
            .setColor(0x0099FF)
            .setDescription('**기본 명령어**')
            .addFields(
                { name: 'w!ping', value: '봇의 응답 속도를 확인합니다.', inline: false },
                { name: 'w!status', value: '현재 봇의 상태와 설정을 확인합니다.', inline: false },
                { name: 'w!flag [지역]', value: '특정 지역의 실시간 상태를 확인합니다.\n예: `w!flag 독도`', inline: false },
                { name: 'w!history [지역]', value: '최근 30분간 해당 지점의 일치율 변화 그래프를 출력합니다.\n예: `w!history 독도`', inline: false },
                { name: 'w!record [지역] [시간]', value: '해당 지역을 지정한 시간동안 녹화하여 MP4 영상으로 제공합니다. (최대 24시간)\n• `w!record 독도 1h` - 1시간 동안 독도 녹화\n• `w!record stop` - 녹화 중지', inline: false },
                { name: 'w!help', value: '이 도움말을 표시합니다.', inline: false },
                
            )
            .setFooter({ text: '💡 화살표 버튼으로 페이지 이동' })
            .setTimestamp(),

        // 페이지 2: 전역 설정
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (2/4)')
            .setColor(0x0099FF)
            .setDescription('**🔧 관리자 전용 - 전역 설정**')
            .addFields(
                { name: 'w!setchannel [지역] #채널', value: '알림을 받을 채널을 설정합니다.\n• `w!setchannel #알림` - 모든 지역 기본값\n• `w!setchannel 독도 #독도알림` - 특정 지역만', inline: false },
                { name: 'w!setrole [지역] @역할', value: '알림 시 멘션할 역할을 설정합니다.\n• `w!setrole @경보` - 모든 지역 기본값\n• `w!setrole 서울 @서울팀` - 특정 지역만', inline: false },
                { name: 'w!setthreshold [지역] 값', value: '태극기 훼손 감지 임계값을 설정합니다.\n• `w!setthreshold 85` - 모든 지역 기본값\n• `w!setthreshold 독도 88` - 특정 지역만\n※ 83% 이하는 권장하지 않습니다.', inline: false },
                { name: 'w!setcooldown [시간]', value: '알림 쿨다운 시간을 설정합니다.\n예: `w!setcooldown 10m`, `w!setcooldown 1h`', inline: false }
            )
            .setFooter({ text: '💡 [지역] 생략 시 전체 적용, 명시 시 해당 지역만 적용' })
            .setTimestamp(),

        // 페이지 3: 구역 관리
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (3/4)')
            .setColor(0x0099FF)
            .setDescription('**🎯 관리자 전용 - 구역 관리**')
            .addFields(
                { name: 'w!disablezone [지역]', value: '특정 지역의 감시를 비활성화합니다.\n예: `w!disablezone 서울`', inline: false },
                { name: 'w!enablezone [지역]', value: '특정 지역의 감시를 재활성화합니다.\n예: `w!enablezone 서울`', inline: false },
                { name: 'w!pause [시간]', value: '전체 감시를 일시 정지합니다.\n예: `w!pause 30m`, `w!pause` (무기한)', inline: false },
                { name: 'w!resume', value: '일시 정지된 감시를 재개합니다.', inline: false }
            )
            .setFooter({ text: '💡 구역별 세밀한 제어가 가능합니다' })
            .setTimestamp(),

        // 페이지 4: 모니터링 & 기타
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (4/4)')
            .setColor(0x0099FF)
            .setDescription('**🔍 관리자 전용 - 모니터링**')
            .addFields(
                { name: 'w!testalert [지역] [silent]', value: '테스트 알림을 전송합니다.\n• `w!testalert 독도` - 역할 멘션 포함\n• `w!testalert 독도 silent` - 역할 멘션 없이', inline: false },
                { name: 'w!resetcooldown [지역]', value: '해당 지역 또는 전체 알림 쿨다운을 초기화합니다.\n예: `w!resetcooldown`, `w!resetcooldown 독도`', inline: false }
            )
            .addFields({ name: '\u200B', value: '**🎉 기타**', inline: false })
            .addFields(
                { name: 'w!mambo', value: '???', inline: false }
            )
            .setFooter({ text: '💡 문의 사항은 봇 프로필의 지원 서버로.' })
            .setTimestamp()
    ];

    let currentPage = 0;

    // 버튼 생성 (discord.js v14 방식)
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
    
    const getButtons = (page) => {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('prev')
                    .setLabel('◀ 이전')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('page')
                    .setLabel(`${page + 1} / ${pages.length}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('다음 ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === pages.length - 1)
            );
        return row;
    };

    const getLinkButtons = () => {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('🎫 서포트 서버')
                .setStyle(ButtonStyle.Link)
                .setURL(SUPPORT_SERVER_URL),
            new ButtonBuilder()
                .setLabel('📊 실시간 대시보드')
                .setStyle(ButtonStyle.Link)
                .setURL(DASHBOARD_URL)
        );
    return row;
};

    // 초기 메시지 전송
    const helpMessage = await message.reply({
        embeds: [pages[currentPage]],
        components: [getButtons(currentPage), getLinkButtons()]
    });

    // 버튼 클릭 이벤트 리스너
    const collector = helpMessage.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 600000 // 10분간 버튼 활성화
    });

    collector.on('collect', async (interaction) => {
        if (interaction.customId === 'prev') {
            currentPage = Math.max(0, currentPage - 1);
        } else if (interaction.customId === 'next') {
            currentPage = Math.min(pages.length - 1, currentPage + 1);
        }

        await interaction.update({
            embeds: [pages[currentPage]],
            components: [getButtons(currentPage), getLinkButtons()]  // ⭐ 배열에 추가
        });
    });

    collector.on('end', () => {
        // 5분 후 버튼 비활성화
        helpMessage.edit({
            embeds: [pages[currentPage]],
            components: [getLinkButtons()]
        }).catch(() => {}); // 메시지가 삭제된 경우 무시
    });
},

    'pause': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    
    const duration = args[0];
    const ms = duration ? parseDuration(duration) : null;

    if (duration && !ms) {
        return message.reply('❌ 시간 형식 오류입니다. (예: 30m, 1h) 또는 시간 없이 입력하면 무기한 정지됩니다.');
    }
    
    if (!ms) {
        // 기간 없이 실행 시 무기한 정지
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { enabled: false },
            { upsert: true }
        );
        return message.reply('⏸️ 이 서버의 태극기 감시가 **무기한 정지**되었습니다.\n재개하려면 `w!resume`을 입력하세요.');
    } else {
        // 기간 지정 시 자동 재개
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { enabled: false },
            { upsert: true }
        );
        
        message.reply(`⏸️ 이 서버의 태극기 감시가 **${durationToKorean(duration)}** 동안 정지되었습니다.\n수동으로 재개하려면 \`w!resume\`을 입력하세요.`);
        
        // 자동 재개 타이머 설정
        setTimeout(async () => {
            const setting = await Setting.findOne({ guildId: message.guild.id });
            if (setting && !setting.enabled) {
                await Setting.findOneAndUpdate(
                    { guildId: message.guild.id },
                    { enabled: true }
                );
                
                // 알림 채널에 자동 재개 메시지 전송
                if (setting.defaultChannelId) {
                    try {
                        const channel = await client.channels.fetch(setting.defaultChannelId);
                        if (channel) {
                            const embed = new EmbedBuilder()
                                .setTitle('▶️ 감시 자동 재개')
                                .setDescription('일시 정지 기간이 만료되어 태극기 감시가 자동으로 재개되었습니다.')
                                .setColor(0x00FF00)
                                .setTimestamp();
                            channel.send({ embeds: [embed] });
                        }
                    } catch (e) {
                        console.error('자동 재개 알림 전송 실패:', e);
                    }
                }
            }
        }, ms);
    }
},

    'resume': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    
    const setting = await Setting.findOne({ guildId: message.guild.id });
    
    if (!setting || setting.enabled) {
        return message.reply('⚠️ 현재 감시가 이미 활성화되어 있습니다.');
    }
    
    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { enabled: true }
    );
    
    message.reply('▶️ 태극기 감시가 **재개**되었습니다!');
},

'mambo': async (message) => {
    try {
        // 맘보 이모지 전송
        const mamboMsg = await message.channel.send('<:mambo:1459544557502070810>');
        
        // 1초 후 삭제
        setTimeout(async () => {
            try {
                await mamboMsg.delete();
            } catch (error) {
                console.log('맘보 메시지 삭제 실패:', error.message);
            }
        }, 1000);

    } catch (error) {
        console.error('mambo 명령어 오류:', error);
    }
},

    'getinvite': async (message, args) => {
        // 1. 개발자 본인 확인
        if (message.author.id !== DEVELOPER_ID) {
            return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
        }

        // 2. 서버 ID 인자 확인
        const targetGuildId = args[0];
        if (!targetGuildId) {
            return message.reply('❌ 서버 ID를 입력해주세요. 사용법: `w!getinvite (서버 ID)`');
        }

        try {
            // 3. 봇이 해당 서버에 있는지 확인
            const guild = client.guilds.cache.get(targetGuildId);
            if (!guild) {
                return message.reply('❌ 봇이 해당 서버에 참여하고 있지 않거나, 잘못된 서버 ID입니다.');
            }

            // 4. 초대장을 생성할 수 있는 채널 찾기 (첫 번째 텍스트 채널)
            const channel = guild.channels.cache.find(ch => 
                ch.isTextBased() && 
                ch.permissionsFor(guild.members.me).has('CreateInstantInvite')
            );

            if (!channel) {
                return message.reply('❌ 해당 서버에서 초대장을 생성할 권한이 없거나 적절한 채널을 찾을 수 없습니다.');
            }

            // 5. 초대장 생성
            const invite = await channel.createInvite({
                maxAge: 0,
                maxUses: 0,
                unique: true,
            });

            // 6. 개발자에게 DM으로 전송 시도
            try {
                await message.author.send(`✅ **${guild.name}** 서버의 초대장이 생성되었습니다:\n${invite.url}`);
                message.reply('📬 초대장을 DM으로 전송했습니다.');
            } catch (dmError) {
                // DM이 차단되어 있을 경우 채널에 직접 전송 (보안상 주의)
                message.reply(`⚠️ DM 전송에 실패했습니다. 초대장: ${invite.url}`);
            }

        } catch (error) {
            console.error('초대장 생성 오류:', error);
            message.reply('❌ 초대장을 생성하는 중 오류가 발생했습니다.');
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

'record': async (message, args) => {
        if (args[0] === 'stop') {
            const session = await RecordSession.findOne({ userId: message.author.id });
            if (!session) return message.reply("❌ 현재 진행 중인 녹화가 없습니다.");

            const confirmEmbed = new EmbedBuilder()
                .setTitle("🎥 녹화 중단 확인")
                .setDescription("정말 녹화를 중지하시겠습니까?\n지금까지 녹화된 이미지는 MP4로 변환되어 DM으로 전송됩니다.")
                .setColor(0xFFA500);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('confirm_stop_record').setLabel('확인').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('cancel_stop_record').setLabel('취소').setStyle(ButtonStyle.Secondary)
            );

            return message.reply({ embeds: [confirmEmbed], components: [row] });
        }

        if (args.length < 2) {
            return message.reply("❌ 사용법: `w!record (지역) (시간)`\n예: `w!record 독도 30m` (최대 24시간)");
        }

        const zone = findZone(args[0]);
        if (!zone) return message.reply(`❌ '${args[0]}' 구역을 찾을 수 없습니다.`);

        const durationMs = parseDuration(args[1]);
        if (!durationMs || durationMs <= 0 || durationMs > MAX_RECORD_DURATION_MS) {
            return message.reply("❌ 시간 형식이 잘못되었거나 범위를 초과했습니다. (최대 24시간)");
        }

        const existing = await RecordSession.findOne({ userId: message.author.id });
        if (existing) return message.reply("❌ 이미 녹화를 진행 중입니다.");

        const endTime = new Date(Date.now() + durationMs);
        await new RecordSession({
            userId: message.author.id,
            zoneName: zone.name,
            endTime: endTime,
            guildId: message.guild.id,
            channelId: message.channel.id
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
            await cleanupRecord(message.author.id);
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
    if (interaction.customId === 'confirm_stop_record') {
        await interaction.update({ content: "✅ 녹화 중단됨", embeds: [], components: [] });
        await RecordSession.updateOne({ userId: interaction.user.id }, { isActive: false });
        await finalizeRecord(interaction.user.id);
    } else if (interaction.customId === 'cancel_stop_record') {
        await interaction.update({ content: "⏺️ 녹화 계속 진행", embeds: [], components: [] });
    }
});

client.once('clientReady', () => {
    console.log(`✅ ${client.user.tag} 온라인! 감시 시스템 가동 중...`);
    console.log(`📡 ${client.guilds.cache.size}개 서버에서 활동 중`);
    cleanupOrphanedTempDirs();

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