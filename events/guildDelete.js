// events/guildDelete.js — 서버 퇴장/추방 로그. 의존성이 없어 공장 함수 없이 바로 export

module.exports = (guild) => {
    const guildName = guild.name || '알 수 없는 서버'; // guild가 partial일 수 있어 대비
    console.log(`📤 ${guildName}에서 퇴장함.`);
};
