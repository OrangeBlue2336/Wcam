// commands/whitelist.js
// 개발자 전용 - 화이트리스트 관리 명령어 (w!whitelist add/remove/list)

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { DEVELOPER_ID } = require('../config/env');
const { Whitelist } = require('../db/models');

module.exports = (deps) => async (message, args) => {
    const { client } = deps;

    // 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    const action = args[0]?.toLowerCase();

    // 사용법 안내
    if (!action || !['add', 'remove', 'list'].includes(action)) {
        const whitelistCount = await Whitelist.countDocuments();
        return message.reply(
            '**화이트리스트 관리**\n' +
            '• `w!whitelist add [서버ID]` - 서버 추가\n' +
            '• `w!whitelist remove [서버ID]` - 서버 제거\n' +
            '• `w!whitelist list` - 목록 확인\n\n' +
            `**현재 상태:** ${whitelistCount}개 서버 등록됨`
        );
    }

    // 목록 확인
    if (action === 'list') {
        const whitelisted = await Whitelist.find().sort({ addedAt: -1 });

        if (whitelisted.length === 0) {
            return message.reply('📋 화이트리스트가 비어있습니다.');
        }

        // 페이지네이션 설정
        const PAGE_SIZE = 10;
        const totalPages = Math.ceil(whitelisted.length / PAGE_SIZE);

        const createListEmbed = (pageIndex) => {
            const start = pageIndex * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, whitelisted.length);
            const pageItems = whitelisted.slice(start, end);

            const embed = new EmbedBuilder()
                .setTitle(`📋 화이트리스트 서버 목록 (${pageIndex + 1}/${totalPages})`)
                .setColor(0x00FF00)
                .setDescription(`총 ${whitelisted.length}개 서버 등록`)
                .setTimestamp();

            for (const item of pageItems) {
                const guild = client.guilds.cache.get(item.guildId);
                const status = guild ? '✅ 참여 중' : '❌ 미참여';
                const currentMembers = guild ? `${guild.memberCount}명` : `${item.memberCount || '?'}명`;

                const info =
                    `**ID:** \`${item.guildId}\`\n` +
                    `${status} | 멤버: ${currentMembers}\n` +
                    `소유자: ${item.ownerTag || '정보 없음'}\n` +
                    `등록일: <t:${Math.floor(item.addedAt.getTime() / 1000)}:R>`;

                embed.addFields({
                    name: item.guildName || '알 수 없는 서버',
                    value: info,
                    inline: false
                });
            }

            return embed;
        };

        let currentPage = 0;
        const firstEmbed = createListEmbed(0);

        // 페이지가 1개면 버튼 없이 전송
        if (totalPages === 1) {
            return message.reply({ embeds: [firstEmbed] });
        }

        // 페이지네이션 버튼
        const getButtons = (page) => {
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('first')
                        .setLabel('⏮️')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('prev')
                        .setLabel('◀')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('page')
                        .setLabel(`${page + 1}/${totalPages}`)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('next')
                        .setLabel('▶')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1),
                    new ButtonBuilder()
                        .setCustomId('last')
                        .setLabel('⏭️')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1)
                );
            return row;
        };

        const listMsg = await message.reply({
            embeds: [firstEmbed],
            components: [getButtons(currentPage)]
        });

        const collector = listMsg.createMessageComponentCollector({
            filter: (i) => i.user.id === message.author.id,
            time: 600000
        });

        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'first') currentPage = 0;
            else if (interaction.customId === 'prev') currentPage = Math.max(0, currentPage - 1);
            else if (interaction.customId === 'next') currentPage = Math.min(totalPages - 1, currentPage + 1);
            else if (interaction.customId === 'last') currentPage = totalPages - 1;

            await interaction.update({
                embeds: [createListEmbed(currentPage)],
                components: [getButtons(currentPage)]
            });
        });

        collector.on('end', () => {
            listMsg.edit({ components: [] }).catch(() => {});
        });

        return;
    }

    // 서버 추가
    if (action === 'add') {
        const guildId = args[1];
        if (!guildId) {
            return message.reply('❌ 추가할 서버 ID를 입력해주세요.');
        }

        // 이미 등록되어 있는지 확인
        const existing = await Whitelist.findOne({ guildId });
        if (existing) {
            return message.reply('⚠️ 이미 화이트리스트에 등록된 서버입니다.');
        }

        // 서버 정보 가져오기
        const guild = client.guilds.cache.get(guildId);
        let guildName = '알 수 없는 서버';
        let ownerTag = '알 수 없음';
        let memberCount = 0;

        if (guild) {
            guildName = guild.name;
            memberCount = guild.memberCount;
            const owner = await client.users.fetch(guild.ownerId).catch(() => null);
            ownerTag = owner ? owner.tag : '알 수 없음';
        }

        // DB에 추가
        await Whitelist.create({
            guildId,
            guildName,
            addedBy: message.author.tag,
            ownerTag,
            memberCount
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ 서버가 화이트리스트에 추가되었습니다')
            .setColor(0x00FF00)
            .addFields(
                { name: '서버 이름', value: guildName, inline: true },
                { name: '서버 ID', value: guildId, inline: true },
                { name: '멤버 수', value: `${memberCount}명`, inline: true },
                { name: '소유자', value: ownerTag, inline: true },
                { name: '등록자', value: message.author.tag, inline: true },
                { name: '봇 참여 상태', value: guild ? '✅ 참여 중' : '❌ 미참여', inline: true }
            )
            .setFooter({ text: guild ? '정상적으로 사용 가능합니다' : '봇 초대 시 정상 작동합니다' })
            .setTimestamp();

        return message.reply({ embeds: [embed] });
    }

    // 서버 제거
    if (action === 'remove') {
        const guildId = args[1];
        if (!guildId) {
            return message.reply('❌ 제거할 서버 ID를 입력해주세요.');
        }

        const existing = await Whitelist.findOne({ guildId });
        if (!existing) {
            return message.reply('⚠️ 해당 서버는 화이트리스트에 없습니다.');
        }

        // DB에서 제거
        await Whitelist.deleteOne({ guildId });

        // 봇이 해당 서버에 있다면 자동 퇴장
        const guild = client.guilds.cache.get(guildId);
        let leftServer = false;

        if (guild) {
            try {
                await guild.leave();
                leftServer = true;
                console.log(`📤 화이트리스트 제거로 인해 ${guild.name}에서 퇴장`);
            } catch (error) {
                console.error(`퇴장 실패 (${guild.name}):`, error);
            }
        }

        const embed = new EmbedBuilder()
            .setTitle('✅ 서버가 화이트리스트에서 제거되었습니다')
            .setColor(0xFFA500)
            .addFields(
                { name: '서버 이름', value: existing.guildName || '알 수 없음', inline: true },
                { name: '서버 ID', value: guildId, inline: true },
                { name: '자동 퇴장', value: leftServer ? '✅ 완료' : '❌ 미참여 중', inline: true }
            )
            .setTimestamp();

        return message.reply({ embeds: [embed] });
    }
};
