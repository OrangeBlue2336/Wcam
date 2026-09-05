// events/guildDelete.js
// 9단계: index.js에 있던 client.on('guildDelete', ...) 로직을 그대로 옮겼습니다.
// 의존성이 전혀 없는 단순 로그 출력이라, 다른 이벤트 파일들과 달리 "공장 함수" 형태 없이
// 함수 자체를 바로 내보냅니다: client.on('guildDelete', require('./events/guildDelete'));

module.exports = (guild) => {
    // 참고: guild 객체가 부분적(partial)일 수 있으므로 이름이 없을 경우를 대비합니다.
    const guildName = guild.name || '알 수 없는 서버';
    console.log(`📤 ${guildName}에서 퇴장함.`);
};
