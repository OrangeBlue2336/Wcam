// commands/setchannel.js
// 알림 채널 설정 명령어 (w!setchannel [구역] #채널)

const { Setting } = require('../db/models');
const monitorZones = require('../config/zones');
const { findZone } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    // 인자가 없는 경우
    if (args.length === 0) {
        return message.reply('❌ 사용법: `w!setchannel [구역] #채널` 또는 `w!setchannel #채널` (전체 적용)');
    }

    let zoneName = null;
    let channelId = null;

    // 경우 1: w!setchannel #채널 (전체 적용)
    if (args.length === 1) {
        channelId = args[0].replace(/[<#>]/g, '');
    }
    // 경우 2: w!setchannel 독도 #채널 (특정 구역)
    else if (args.length >= 2) {
        // 마지막 인자가 채널
        channelId = args[args.length - 1].replace(/[<#>]/g, '');
        // 나머지가 구역 이름
        zoneName = args.slice(0, -1).join(' ');

        // 구역 유효성 검사
        const zone = findZone(zoneName);
        if (!zone) {
            return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다. 사용 가능한 구역: ${monitorZones.map(z => z.name).join(', ')}`);
        }
        zoneName = zone.name; // 정확한 이름으로 통일
    }

    // 채널 유효성 검사
    const channel = message.guild.channels.cache.get(channelId);
    if (!channel) {
        return message.reply('❌ 해당 채널을 찾을 수 없습니다. 올바른 채널을 입력해주세요.');
    }
    if (!channel.isTextBased()) {
        return message.reply('❌ 텍스트 채널만 설정할 수 있습니다.');
    }

    // DB 업데이트
    if (zoneName) {
        // 특정 구역에만 적용
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { $set: { [`zones.${zoneName}.channelId`]: channelId } },
            { upsert: true }
        );
        message.reply(`✅ **${zoneName}** 구역의 알림 채널이 <#${channelId}>(으)로 설정되었습니다.`);
    } else {
        // 전체 기본값으로 적용
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { defaultChannelId: channelId },
            { upsert: true }
        );
        message.reply(`✅ 모든 구역의 기본 알림 채널이 <#${channelId}>(으)로 설정되었습니다.\n(개별 구역 설정이 없는 경우 이 채널이 사용됩니다)`);
    }
};
