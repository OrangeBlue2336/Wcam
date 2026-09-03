// commands/servers.js
// 개발자 전용 - 봇이 참여 중인 서버 목록/통계 명령어 (w!servers)

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { DEVELOPER_ID } = require('../config/env');
const { Setting } = require('../db/models');

module.exports = (deps) => async (message) => {
    const { client } = deps;

    // 1. 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    const statusMsg = await message.reply('📊 서버 목록을 불러오는 중...');

    // 2. 서버 정보 수집
    const guilds = Array.from(client.guilds.cache.values());

    // 총 통계
    const totalMembers = guilds.reduce((sum, g) => sum + g.memberCount, 0);
    const totalChannels = guilds.reduce((sum, g) => sum + g.channels.cache.size, 0);

    // 3. 서버 목록을 여러 페이지로 나누기 (한 페이지당 10개)
    const PAGE_SIZE = 10;
    const totalPages = Math.ceil(guilds.length / PAGE_SIZE);

    const createEmbed = async (pageIndex) => {
        const start = pageIndex * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, guilds.length);
        const pageGuilds = guilds.slice(start, end);

        const embed = new EmbedBuilder()
            .setTitle(`🌐 봇 서버 목록 (${pageIndex + 1}/${totalPages})`)
            .setColor(0x0099FF)
            .setDescription(
                `**전체 통계**\n` +
                `📊 총 서버: ${guilds.length}개\n` +
                `👥 총 멤버: ${totalMembers.toLocaleString()}명\n` +
                `📺 총 채널: ${totalChannels.toLocaleString()}개\n\n` +
                `**서버 목록 (${start + 1}-${end}/${guilds.length})**`
            )
            .setTimestamp();

        // 각 서버 정보 추가
        for (const guild of pageGuilds) {
            const owner = await client.users.fetch(guild.ownerId).catch(() => null);
            const ownerTag = owner ? `${owner.tag}` : '알 수 없음';

            // 서버 설정 정보 가져오기
            const setting = await Setting.findOne({ guildId: guild.id });
            const hasSetup = setting && setting.defaultChannelId ? '✅' : '⚠️';

            const info =
                `**ID:** \`${guild.id}\`\n` +
                `👥 멤버: ${guild.memberCount.toLocaleString()}명\n` +
                `📺 채널: ${guild.channels.cache.size}개\n` +
                `👑 소유자: ${ownerTag}\n` +
                `${hasSetup} 설정 상태\n` +
                `📅 가입일: <t:${Math.floor(guild.joinedTimestamp / 1000)}:R>`;

            embed.addFields({
                name: `${guild.name}`,
                value: info,
                inline: false
            });
        }

        return embed;
    };

    // 4. 첫 페이지 전송
    let currentPage = 0;
    const firstEmbed = await createEmbed(0);

    // 페이지가 1개면 버튼 없이 전송
    if (totalPages === 1) {
        return await statusMsg.edit({ content: null, embeds: [firstEmbed] });
    }

    // 5. 페이지 네비게이션 버튼 생성
    const getButtons = (page) => {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('first')
                    .setLabel('⏮️ 첫 페이지')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('prev')
                    .setLabel('◀ 이전')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('page')
                    .setLabel(`${page + 1} / ${totalPages}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('다음 ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1),
                new ButtonBuilder()
                    .setCustomId('last')
                    .setLabel('마지막 페이지 ⏭️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
        return row;
    };

    // 6. 초기 메시지 업데이트
    const serverListMsg = await statusMsg.edit({
        content: null,
        embeds: [firstEmbed],
        components: [getButtons(currentPage)]
    });

    // 7. 버튼 클릭 이벤트 리스너
    const collector = serverListMsg.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 600000 // 10분간 버튼 활성화
    });

    collector.on('collect', async (interaction) => {
        if (interaction.customId === 'first') {
            currentPage = 0;
        } else if (interaction.customId === 'prev') {
            currentPage = Math.max(0, currentPage - 1);
        } else if (interaction.customId === 'next') {
            currentPage = Math.min(totalPages - 1, currentPage + 1);
        } else if (interaction.customId === 'last') {
            currentPage = totalPages - 1;
        }

        const newEmbed = await createEmbed(currentPage);
        await interaction.update({
            embeds: [newEmbed],
            components: [getButtons(currentPage)]
        });
    });

    collector.on('end', () => {
        // 10분 후 버튼 비활성화
        serverListMsg.edit({
            components: []
        }).catch(() => {}); // 메시지가 삭제된 경우 무시
    });
};
