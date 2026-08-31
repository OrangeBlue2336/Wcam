const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const monitorZones = require('../config/zones');

// 짧고 사람이 입력하기 쉬운 복구용 세션 ID 생성 (예: A1B2C3D4)
function generateSessionId() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

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

module.exports = {
    generateSessionId,
    parseDuration,
    durationToKorean,
    findZone,
    cleanupOrphanedTempDirs,
    getZoneSetting
};
