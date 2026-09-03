// commands/updatenotif.js
// 개발자 전용 - 전체 서버 업데이트 알림 발송 명령어 (w!updatenotif)

const { EmbedBuilder } = require('discord.js');
const { DEVELOPER_ID } = require('../config/env');

module.exports = (deps) => async (message) => {
    const { client } = deps;

    // 1. 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    const statusMsg = await message.reply('📢 업데이트 알림을 전송하는 중...');

    let successCount = 0;
    let failCount = 0;
    const failedServers = [];

    // 2. 모든 서버 순회
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            // 메시지 전송 권한이 있는 첫 번째 텍스트 채널 찾기
            const channel = guild.channels.cache.find(ch =>
                ch.isTextBased() &&
                ch.permissionsFor(guild.members.me).has('SendMessages') &&
                ch.permissionsFor(guild.members.me).has('EmbedLinks')
            );

            if (!channel) {
                failCount++;
                failedServers.push(`${guild.name} (전송 가능한 채널 없음)`);
                continue;
            }

            // 임베드 메시지 생성
            const embed = new EmbedBuilder()
                .setTitle('🔔 봇 업데이트 알림')
                .setDescription('봇이 업데이트 되었습니다.\n`w!status` 명령어를 사용하여 서버 설정을 다시 한번 확인해주세요.')
                .setColor(0x0099FF)
                .setTimestamp();

            // 메시지 전송 (멘션 없음)
            await channel.send({ embeds: [embed] });
            successCount++;

        } catch (error) {
            console.error(`알림 전송 실패 (${guild.name}):`, error.message);
            failCount++;
            failedServers.push(`${guild.name} (오류: ${error.message})`);
        }
    }

    // 3. 결과 보고
    const resultEmbed = new EmbedBuilder()
        .setTitle('📊 업데이트 알림 전송 완료')
        .setColor(failCount > 0 ? 0xFFA500 : 0x00FF00)
        .addFields(
            { name: '✅ 성공', value: `${successCount}개 서버`, inline: true },
            { name: '❌ 실패', value: `${failCount}개 서버`, inline: true },
            { name: '📈 전체', value: `${client.guilds.cache.size}개 서버`, inline: true }
        )
        .setTimestamp();

    if (failedServers.length > 0) {
        const failedList = failedServers.slice(0, 10).join('\n');
        const moreText = failedServers.length > 10 ? `\n... 외 ${failedServers.length - 10}개` : '';
        resultEmbed.addFields({
            name: '⚠️ 실패한 서버 목록',
            value: failedList + moreText,
            inline: false
        });
    }

    await statusMsg.edit({ content: null, embeds: [resultEmbed] });
};
