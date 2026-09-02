// commands/mambo.js
// 맘보 이모지 명령어 (w!mambo)

module.exports = (deps) => async (message) => {
    try {
        // 맘보 이모지 전송
        const mamboMsg = await message.channel.send('<:mambo:1459544557502070810>');

        // 1초 후 삭제
        setTimeout(async () => {
            try {
                await mamboMsg.delete();
            } catch (error) {
                console.log('맘보 메시지 삭제 실패:', error.message);
            }
        }, 1000);

    } catch (error) {
        console.error('mambo 명령어 오류:', error);
    }
};
