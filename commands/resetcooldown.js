// commands/resetcooldown.js
// 알림 쿨다운 초기화 명령어 (w!resetcooldown [구역])

const { findZone } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
    const { lastAlertTime } = deps;

    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }

    const zoneName = args.join(' ');
    if (!zoneName) {
        // 해당 서버의 모든 구역 쿨다운 초기화
        for (const key in lastAlertTime) {
            if (key.startsWith(message.guild.id)) {
                delete lastAlertTime[key];
            }
        }
        return message.reply('✅ 이 서버의 모든 구역 알림 쿨다운이 초기화되었습니다.');
    }

    const zone = findZone(zoneName);
    if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

    delete lastAlertTime[`${message.guild.id}-${zone.name}`];
    message.reply(`✅ ${zone.name}의 알림 쿨다운이 초기화되었습니다.`);
};
