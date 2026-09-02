// commands/resume.js
// 일시 정지된 감시 재개 명령어 (w!resume)

const { Setting } = require('../db/models');

module.exports = (deps) => async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }

    const setting = await Setting.findOne({ guildId: message.guild.id });

    if (!setting || setting.enabled) {
        return message.reply('⚠️ 현재 감시가 이미 활성화되어 있습니다.');
    }

    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { enabled: true }
    );

    message.reply('▶️ 태극기 감시가 **재개**되었습니다!');
};
