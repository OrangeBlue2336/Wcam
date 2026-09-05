// events/messageCreate.js — 'w!' 명령어를 파싱해 commands 객체(commands/index.js)에서 찾아 실행

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
