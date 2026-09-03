// commands/setrole.js
// 알림 역할 설정 명령어 (w!setrole [구역] @역할)

const { Setting } = require('../db/models');
const { findZone } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
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
};
