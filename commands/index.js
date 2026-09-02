// commands/index.js
// commands 폴더 안의 모든 명령어 파일을 자동으로 불러와 하나의 객체로 합칩니다.
// 각 명령어 파일은 (deps) => async (message, args) => {...} 형태의 "공장 함수"를 내보내며,
// deps에는 client처럼 index.js에서 이미 만들어진 것들이나, 아직 다른 모듈로
// 옮겨지지 않은 함수/상태(sendAlert, lastAlertTime 등)가 담겨 전달됩니다.
//
// ⚠️ 아직 7-2/7-3 단계가 끝나지 않아, 모든 명령어가 이 폴더로 옮겨진 것은 아닙니다.
// 나머지 명령어들은 index.js 안의 commands 객체에 남아있고,
// index.js에서 이 파일이 반환하는 객체와 합쳐서 최종 commands 객체를 만듭니다.

const fs = require('fs');
const path = require('path');

module.exports = (deps) => {
    const commands = {};

    fs.readdirSync(__dirname)
        .filter((file) => file !== 'index.js' && file.endsWith('.js'))
        .forEach((file) => {
            const commandName = file.replace('.js', '');
            commands[commandName] = require(path.join(__dirname, file))(deps);
        });

    return commands;
};
