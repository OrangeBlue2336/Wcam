// events/clientReady.js — 로그 출력, 임시 파일 정리, Rich Presence 교체, 감시/녹화 주기 작업(setInterval) 등록.
// checkZones/migrateLegacySessionIds/processRecordings는 index.js가 만든 단일 인스턴스를 deps로 받고,
// CAPTURE_INTERVAL_MS·cleanupOrphanedTempDirs는 직접 require

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
