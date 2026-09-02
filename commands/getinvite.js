// commands/getinvite.js
// 개발자 전용 - 특정 서버 초대장 생성 명령어 (w!getinvite [서버ID])

const { DEVELOPER_ID } = require('../config/env');

module.exports = (deps) => async (message, args) => {
    const { client } = deps;

    // 1. 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    // 2. 서버 ID 인자 확인
    const targetGuildId = args[0];
    if (!targetGuildId) {
        return message.reply('❌ 서버 ID를 입력해주세요. 사용법: `w!getinvite (서버 ID)`');
    }

    try {
        // 3. 봇이 해당 서버에 있는지 확인
        const guild = client.guilds.cache.get(targetGuildId);
        if (!guild) {
            return message.reply('❌ 봇이 해당 서버에 참여하고 있지 않거나, 잘못된 서버 ID입니다.');
        }

        // 4. 초대장을 생성할 수 있는 채널 찾기 (첫 번째 텍스트 채널)
        const channel = guild.channels.cache.find(ch =>
            ch.isTextBased() &&
            ch.permissionsFor(guild.members.me).has('CreateInstantInvite')
        );

        if (!channel) {
            return message.reply('❌ 해당 서버에서 초대장을 생성할 권한이 없거나 적절한 채널을 찾을 수 없습니다.');
        }

        // 5. 초대장 생성
        const invite = await channel.createInvite({
            maxAge: 0,
            maxUses: 0,
            unique: true,
        });

        // 6. 개발자에게 DM으로 전송 시도
        try {
            await message.author.send(`✅ **${guild.name}** 서버의 초대장이 생성되었습니다:\n${invite.url}`);
            message.reply('📬 초대장을 DM으로 전송했습니다.');
        } catch (dmError) {
            // DM이 차단되어 있을 경우 채널에 직접 전송 (보안상 주의)
            message.reply(`⚠️ DM 전송에 실패했습니다. 초대장: ${invite.url}`);
        }

    } catch (error) {
        console.error('초대장 생성 오류:', error);
        message.reply('❌ 초대장을 생성하는 중 오류가 발생했습니다.');
    }
};
