// events/messageCreate.js
// 9단계: index.js에 있던 client.on('messageCreate', ...) 로직을 그대로 옮겼습니다.
// 'w!'로 시작하는 메시지를 파싱해서 commands 객체(commands/index.js가 만든 것)에서
// 해당 명령어를 찾아 실행합니다.
//
// index.js에서 이미 완성된 commands 객체를 그대로 주입받아 사용합니다:
//   client.on('messageCreate', require('./events/messageCreate')(commands));

module.exports = (commands) => async (message) => {
    if (!message.content.toLowerCase().startsWith('w!') || message.author.bot) return;

    const args = message.content.slice(2).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    if (commands[commandName]) {
        try {
            await commands[commandName](message, args);
        } catch (error) {
            console.error('명령어 실행 오류:', error);
            message.reply('❌ 명령어 실행 중 오류가 발생했습니다.');
        }
    }
};
