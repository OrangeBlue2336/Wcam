// commands/enablezone.js
// 특정 구역 감시 재활성화 명령어 (w!enablezone [구역])
// 참고: REFACTOR_PLAN.md의 17개 명령어 목록에는 없었지만, 원본 index.js에
// disablezone과 짝을 이루어 존재하던 명령어라 7-1단계에서 함께 옮겼습니다.

const { Setting } = require('../db/models');
const monitorZones = require('../config/zones');
const { findZone } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
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
};
