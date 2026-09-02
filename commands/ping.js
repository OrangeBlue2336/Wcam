// commands/ping.js
// 봇 응답 속도 확인 명령어 (w!ping)

module.exports = (deps) => async (message) => {
    const sent = await message.reply('퐁! 측정 중...');
    sent.edit(`퐁! 지연 시간: ${sent.createdTimestamp - message.createdTimestamp}ms`);
};
