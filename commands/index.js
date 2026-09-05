// commands/index.js — commands/ 폴더의 모든 명령어 파일을 자동으로 불러와 하나의 객체로 합침
// 각 파일은 (deps) => async (message, args) => {...} 형태의 공장 함수를 내보내고, deps에는 client·공유 상태가 담겨 전달

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

    // 별칭: w!f → flag, w!h → history, w!r → record
    commands['f'] = commands['flag'];
    commands['h'] = commands['history'];
    commands['r'] = commands['record'];

    return commands;
};