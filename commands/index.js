// commands/index.js
// commands 폴더 안의 모든 명령어 파일을 자동으로 불러와 하나의 객체로 합칩니다.
// 각 명령어 파일은 (deps) => async (message, args) => {...} 형태의 "공장 함수"를 내보내며,
// deps에는 client처럼 index.js에서 이미 만들어진 것들이나, services/recording.js·
// services/monitor.js가 관리하는 공유 상태(sendAlert, lastAlertTime, zoneHistory,
// pendingArtworkRecords 등)가 담겨 전달됩니다.
//
// 7-3단계가 모두 끝나 flag/history/record가 이 폴더로 옮겨졌으므로,
// 예전에 index.js 쪽 commands 객체에 있던 별칭 f/h/r도 이제 이 로더에서 붙입니다.

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