// commands/setthreshold.js
// 훼손 감지 임계값 설정 명령어 (w!setthreshold [구역] 값)

const { Setting } = require('../db/models');
const { findZone } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
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
};
