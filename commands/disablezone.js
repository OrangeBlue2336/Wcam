// commands/disablezone.js
// 특정 구역 감시 비활성화 명령어 (w!disablezone [구역])

const { Setting } = require('../db/models');
const monitorZones = require('../config/zones');
const { findZone } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
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
};
