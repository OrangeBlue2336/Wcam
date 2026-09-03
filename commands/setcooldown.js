// commands/setcooldown.js
// 알림 쿨다운 시간 설정 명령어 (w!setcooldown [시간])

const { Setting } = require('../db/models');
const { parseDuration, durationToKorean } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }

    if (!args[0]) {
        return message.reply('❌ 시간을 입력해주세요. (예: 10m, 1h, 30s)');
    }

    const duration = args[0];
    const ms = parseDuration(duration);
    if (!ms) return message.reply('❌ 시간 형식 오류입니다. (예: 10m, 1h, 30s)');

    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { cooldownTime: ms },
        { upsert: true }
    );

    message.reply(`✅ 알림 쿨다운이 ${durationToKorean(duration)}(으)로 설정되었습니다.`);
};
