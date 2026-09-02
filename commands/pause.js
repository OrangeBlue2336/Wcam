// commands/pause.js
// 감시 일시 정지 명령어 (w!pause [시간])

const { EmbedBuilder } = require('discord.js');
const { Setting } = require('../db/models');
const { parseDuration, durationToKorean } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
    const { client } = deps;

    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }

    const duration = args[0];
    const ms = duration ? parseDuration(duration) : null;

    if (duration && !ms) {
        return message.reply('❌ 시간 형식 오류입니다. (예: 30m, 1h) 또는 시간 없이 입력하면 무기한 정지됩니다.');
    }

    if (!ms) {
        // 기간 없이 실행 시 무기한 정지
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { enabled: false },
            { upsert: true }
        );
        return message.reply('⏸️ 이 서버의 태극기 감시가 **무기한 정지**되었습니다.\n재개하려면 `w!resume`을 입력하세요.');
    } else {
        // 기간 지정 시 자동 재개
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { enabled: false },
            { upsert: true }
        );

        message.reply(`⏸️ 이 서버의 태극기 감시가 **${durationToKorean(duration)}** 동안 정지되었습니다.\n수동으로 재개하려면 \`w!resume\`을 입력하세요.`);

        // 자동 재개 타이머 설정
        setTimeout(async () => {
            const setting = await Setting.findOne({ guildId: message.guild.id });
            if (setting && !setting.enabled) {
                await Setting.findOneAndUpdate(
                    { guildId: message.guild.id },
                    { enabled: true }
                );

                // 알림 채널에 자동 재개 메시지 전송
                if (setting.defaultChannelId) {
                    try {
                        const channel = await client.channels.fetch(setting.defaultChannelId);
                        if (channel) {
                            const embed = new EmbedBuilder()
                                .setTitle('▶️ 감시 자동 재개')
                                .setDescription('일시 정지 기간이 만료되어 태극기 감시가 자동으로 재개되었습니다.')
                                .setColor(0x00FF00)
                                .setTimestamp();
                            channel.send({ embeds: [embed] });
                        }
                    } catch (e) {
                        console.error('자동 재개 알림 전송 실패:', e);
                    }
                }
            }
        }, ms);
    }
};
