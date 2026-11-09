const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const monitorZones = require('../config/zones');
const pixelmatch = require('pixelmatch').default || require('pixelmatch');

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

// --- 투명 픽셀을 포함한 불일치 픽셀 계산 ---
// pixelmatch는 투명 픽셀을 "흰색 배경 위에 얹은 색"으로 취급하기 때문에,
// 원본의 불투명 흰색이 현재 투명(훼손)으로 바뀌어도 "일치"로 세는 문제가 있음.
// 그래서 투명 여부(알파)가 서로 다른 픽셀은 직접 불일치로 세고,
// 양쪽 모두 투명인 픽셀은 일치로 세며, 나머지(양쪽 모두 불투명)만 pixelmatch에 맡김.
const TRANSPARENT_ALPHA_THRESHOLD = 128; // 알파가 이 값 미만이면 "투명"으로 판단

function isTransparentPixel(data, idx) {
    return data[idx + 3] < TRANSPARENT_ALPHA_THRESHOLD;
}

function countDiffPixels(originalData, currentData, width, height, options = { threshold: 0.1 }) {
    const a = Buffer.from(originalData); // 원본 버퍼를 건드리지 않도록 복사본 사용
    const b = Buffer.from(currentData);
    let transparencyDiffCount = 0;

    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const aTrans = isTransparentPixel(a, idx);
        const bTrans = isTransparentPixel(b, idx);

        if (!aTrans && !bTrans) continue; // 양쪽 불투명 → pixelmatch가 색 비교

        if (aTrans !== bTrans) transparencyDiffCount++; // 한쪽만 투명 → 불일치

        // 투명이 낀 픽셀은 여기서 판정을 끝냈으므로, pixelmatch가 중복 계산하지 않게 양쪽을 같은 값으로 통일
        for (let k = 0; k < 4; k++) {
            a[idx + k] = 255;
            b[idx + k] = 255;
        }
    }

    const diffOut = new Uint8Array(width * height * 4);
    const colorDiffCount = pixelmatch(a, b, diffOut, width, height, options);
    return colorDiffCount + transparencyDiffCount;
}

module.exports = {
    generateSessionId,
    parseDuration,
    durationToKorean,
    findZone,
    cleanupOrphanedTempDirs,
    getZoneSetting,
    isTransparentPixel,
    countDiffPixels
};
