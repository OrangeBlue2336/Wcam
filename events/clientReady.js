// events/clientReady.js
// 9단계: index.js에 있던 client.once('clientReady', ...) 로직을 그대로 옮겼습니다.
// (로그 출력, 임시 디렉토리 정리, 레거시 세션 마이그레이션, Rich Presence 상태 교체,
//  감시/녹화 주기 작업 setInterval 등록)
//
// checkZones(services/monitor.js)와 migrateLegacySessionIds/processRecordings
// (services/recording.js)는 index.js에서 이미 "한 번만" 생성된 단일 인스턴스를 그대로
// deps로 주입받아야 합니다 (record.js, history.js 등 다른 곳과 같은 상태를 공유해야 하므로).
//
// CAPTURE_INTERVAL_MS(config/env)와 cleanupOrphanedTempDirs(utils/helpers)는 상태 공유가
// 필요 없는 정적인 것들이라 다른 파일들과 마찬가지로 이 파일에서 직접 require합니다.

const { CAPTURE_INTERVAL_MS } = require('../config/env');
const { cleanupOrphanedTempDirs } = require('../utils/helpers');

module.exports = (deps) => {
    const { client, checkZones, migrateLegacySessionIds, processRecordings } = deps;

    return () => {
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
    };
};
