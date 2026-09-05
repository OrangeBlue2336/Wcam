require('dotenv').config();

// 전역 설정 및 상수
const RECORD_FPS = 30; // 수정이 용이하도록 상단에 배치
const MAX_RECORD_DURATION_MS = 24 * 60 * 60 * 1000; // 최대 24시간
const CAPTURE_INTERVAL_MS = 30000; // 30초마다 캡처 (기존 감시 주기와 동일하게 설정)

// API 보안 설정
const API_SECRET_KEY = process.env.API_SECRET_KEY || '';

// 환경 변수 설정 (Render에서 설정할 것들)
const MONGODB_URI = (process.env.NODE_ENV === 'development')
    ? (process.env.MONGODB_URI_DEV || process.env.MONGODB_URI || '')
    : (process.env.MONGODB_URI || '');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const KOYEB_URL = process.env.KOYEB_PUBLIC_DOMAIN
    ? `https://${process.env.KOYEB_PUBLIC_DOMAIN}`
    : '';
const NODE_ENV = process.env.NODE_ENV || 'production';
const DEVELOPER_ID = process.env.DEVELOPER_ID || '' ;
const SUPPORT_SERVER_URL = process.env.SUPPORT_SERVER_URL || 'https://discord.gg/utxeK62GJV';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://orangeblue2336.github.io/wplace';


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

// Express 웹서버 포트
const PORT = process.env.PORT || 3000;

module.exports = {
    RECORD_FPS,
    MAX_RECORD_DURATION_MS,
    CAPTURE_INTERVAL_MS,
    API_SECRET_KEY,
    MONGODB_URI,
    BOT_TOKEN,
    KOYEB_URL,
    NODE_ENV,
    DEVELOPER_ID,
    SUPPORT_SERVER_URL,
    DASHBOARD_URL,
    IS_DEV,
    PORT
};
