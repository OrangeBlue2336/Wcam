// commands/status.js
// 봇 전체 상태 확인 명령어 (w!status)

const { EmbedBuilder } = require('discord.js');
const { Setting } = require('../db/models');
const monitorZones = require('../config/zones');

module.exports = (deps) => async (message) => {
    const setting = await Setting.findOne({ guildId: message.guild.id });

    const embed = new EmbedBuilder()
        .setTitle('📊 Wcam 봇 상태')
        .setColor(0x0099FF)
        .setTimestamp();

    // 감시 중인 구역
    const zoneList = monitorZones.map(z => z.name).join('\n');
    embed.addFields({ name: '🔍 감시 중인 구역', value: zoneList, inline: false });

    if (setting) {
        // 전역 설정
        const globalSettings =
            `**상태:** ${setting.enabled ? '✅ 활성화' : '⏸️ 일시 정지'}\n` +
            `**쿨다운:** ${setting.cooldownTime / 60000}분`;
        embed.addFields({ name: '⚙️ 전역 설정', value: globalSettings, inline: false });

        // 기본 설정
        const defaultChannel = setting.defaultChannelId ? `<#${setting.defaultChannelId}>` : '미설정';
        const defaultRole = setting.defaultRoleId
            ? (message.guild.roles.cache.get(setting.defaultRoleId)?.name || setting.defaultRoleId)
            : '미설정';
        const defaultThreshold = setting.defaultThreshold || 90;

        const defaultSettings =
            `**채널:** ${defaultChannel}\n` +
            `**역할:** ${defaultRole}\n` +
            `**임계값:** ${defaultThreshold}%`;
        embed.addFields({ name: '📌 기본 설정', value: defaultSettings, inline: false });

        // 구역별 개별 설정
        if (setting.zones && setting.zones.size > 0) {
            let zoneSettings = '';
            for (const [zoneName, zoneConfig] of setting.zones) {
                const parts = [];
                if (zoneConfig.channelId) {
                    parts.push(`채널: <#${zoneConfig.channelId}>`);
                }
                if (zoneConfig.roleId) {
                    const role = message.guild.roles.cache.get(zoneConfig.roleId);
                    parts.push(`역할: ${role ? role.name : zoneConfig.roleId}`);
                }
                if (zoneConfig.threshold !== undefined) {
                    parts.push(`임계값: ${zoneConfig.threshold}%`);
                }
                if (zoneConfig.enabled === false) {
                    parts.push(`⏸️ 비활성화`);
                }

                if (parts.length > 0) {
                    zoneSettings += `**${zoneName}**\n${parts.join(' | ')}\n\n`;
                }
            }

            if (zoneSettings) {
                embed.addFields({ name: '🎯 구역별 개별 설정', value: zoneSettings.trim(), inline: false });
            }
        }
    } else {
        embed.setDescription('아직 설정되지 않았습니다.\n`w!setchannel`과 `w!setrole`로 설정해주세요.');
    }

    message.reply({ embeds: [embed] });
};
