// commands/testalert.js
// 강제 테스트 알림 발송 명령어 (w!testalert [구역] [silent])
// sendAlert 함수는 8단계(services/monitor.js)에서 옮겨지기 전까지는
// index.js에 남아있으므로, deps로 주입받아 사용합니다.

const axios = require('axios');
const sharp = require('sharp');
const { Setting } = require('../db/models');
const { findZone, getZoneSetting } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
    const { sendAlert } = deps;

    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }

    // silent 옵션 확인
    const isSilent = args.includes('silent');

    // silent 제거 후 구역 이름 추출
    const zoneNameArgs = args.filter(arg => arg.toLowerCase() !== 'silent');
    const zoneName = zoneNameArgs.join(' ') || "독도 태극기";

    const zone = findZone(zoneName);
    if (!zone) return message.reply('❌ 테스트할 구역을 찾을 수 없습니다.');

    const silentText = isSilent ? ' (조용한 모드)' : '';
    message.reply(`🔔 [테스트] ${zone.name} 구역의 강제 알림 테스트를 시작합니다...${silentText}`);

    try {
        const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
        const currentFlagBuffer = await sharp(Buffer.from(response.data))
            .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
            .toBuffer();

        const testTotalPixels = zone.width * zone.height;
        const setting = await Setting.findOne({ guildId: message.guild.id });

        const channelId = getZoneSetting(setting, zone.name, 'channelId');
        const roleId = getZoneSetting(setting, zone.name, 'roleId');
        const serverThreshold = getZoneSetting(setting, zone.name, 'threshold') || 90;

      await sendAlert(
        zone,
        0.00,
        currentFlagBuffer,
        message.guild.id,
        0,
        testTotalPixels,
        testTotalPixels,
        serverThreshold,
        channelId,
        roleId,
        isSilent
    );
    const resultText = isSilent
        ? '✅ 테스트 알림이 전송되었습니다. (역할 멘션 없음)'
        : '✅ 테스트 알림이 전송되었습니다. (역할 멘션 포함)';
    message.channel.send(resultText);
} catch (error) {
    console.error(error);
    message.reply('❌ 테스트 알림 전송 중 오류가 발생했습니다.');
}
};
