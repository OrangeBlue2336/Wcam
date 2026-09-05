const mongoose = require('mongoose');

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

// 화이트리스트 스키마 추가
const WhitelistSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    guildName: String,
    addedBy: String,
    addedAt: { type: Date, default: Date.now },
    ownerTag: String,
    memberCount: Number
});

const Whitelist = mongoose.model('Whitelist', WhitelistSchema);

// 녹화 세션 정보 (누가, 어디를, 언제까지 녹화하는지)
const RecordSessionSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    sessionType: { type: String, enum: ['flag', 'artwork'], default: 'flag' },
    sessionId: { type: String, index: true }, // 복구용 고유 ID (w!record recover 명령어에 사용)
    zoneName: String,          // 태극기 녹화 전용
    tileX: Number,             // 작품 녹화 전용
    tileY: Number,
    localX: Number,
    localY: Number,
    captureWidth: Number,
    captureHeight: Number,
    frameCount: { type: Number, default: 0 },
    startTime: { type: Date, default: Date.now },
    endTime: Date,
    isActive: { type: Boolean, default: true },
    needsRecovery: { type: Boolean, default: false }, // 인코딩/전송 중 오류로 중단되어 복구 대기 중인지 여부
    commandChannelId: String,   // 녹화를 시작한 채널 (자동 종료 시 상태 메시지를 보낼 곳)
    statusChannelId: String,    // "영상을 생성합니다..." 등 진행 상황을 표시 중인 메시지의 채널
    statusMessageId: String     // 위 메시지의 ID (DM 대신 이 메시지를 수정해서 결과/오류를 안내)
});

const RecordSession = mongoose.model('RecordSession', RecordSessionSchema);

// 녹화 프레임 데이터 (이미지 바이너리 저장)
const RecordFrameSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    sessionType: { type: String, default: 'flag' },
    frameData: Buffer,
    timestamp: { type: Date, default: Date.now }
});

RecordFrameSchema.index({ userId: 1, sessionType: 1, timestamp: 1 });

const RecordFrame = mongoose.model('RecordFrame', RecordFrameSchema);

module.exports = { Setting, Whitelist, RecordSession, RecordFrame };
