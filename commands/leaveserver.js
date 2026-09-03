// commands/leaveserver.js
// 개발자 전용 - 특정 서버 강제 퇴장 명령어 (w!leaveserver [서버ID])

const { DEVELOPER_ID } = require('../config/env');

module.exports = (deps) => async (message, args) => {
    const { client } = deps;

    // 1. 개발자 본인 확인 (DEVELOPER_ID는 config/env에서 가져옴)
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    // 2. 서버 ID 인자 확인
    const targetGuildId = args[0];
    if (!targetGuildId) {
        return message.reply('❌ 퇴장할 서버 ID를 입력해주세요. 사용법: `w!leaveserver (서버 ID)`');
    }

    try {
        // 3. 봇이 해당 서버에 있는지 확인
        const guild = client.guilds.cache.get(targetGuildId);
        if (!guild) {
            return message.reply('❌ 봇이 해당 서버에 참여하고 있지 않거나, 잘못된 서버 ID입니다.');
        }

        const guildName = guild.name;

        // 4. 서버 퇴장 실행
        await guild.leave();

        // 5. 결과 보고 (콘솔 및 채팅)
        console.log(`🖕 개발자 지시로 ${guildName}에서 퇴장하였습니다.`);
        message.reply(`✅ 성공적으로 **${guildName}** 서버에서 퇴장하였습니다.`);

    } catch (error) {
        console.error('서버 퇴장 중 오류 발생:', error);
        message.reply('❌ 서버에서 퇴장하는 중 예외가 발생했습니다. 콘솔 로그를 확인해주세요.');
    }
};
