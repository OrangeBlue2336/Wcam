// events/guildCreate.js — 새 서버 초대 시 화이트리스트 체크, 미등록 서버 자동 퇴장 + 개발자 DM 알림.
// client는 index.js에서 주입받고(client.users.fetch 사용), Whitelist·DEVELOPER_ID·EmbedBuilder는 직접 require

const { EmbedBuilder } = require('discord.js');
const { DEVELOPER_ID } = require('../config/env');
const { Whitelist } = require('../db/models');

module.exports = (client) => async (guild) => {
    console.log(`🔔 새 서버 초대 감지: ${guild.name} (ID: ${guild.id})`);

    // 화이트리스트 체크
    const isWhitelisted = await Whitelist.findOne({ guildId: guild.id });

    if (!isWhitelisted) {
        console.log(`🚫 화이트리스트에 없는 서버 감지: ${guild.name} (ID: ${guild.id})`);

        try {
            // 서버 소유자 정보
            const owner = await client.users.fetch(guild.ownerId).catch(() => null);
            const ownerTag = owner ? owner.tag : '알 수 없음';

            // 봇 초대자 정보 (audit log에서 확인 시도)
            let inviter = '알 수 없음';
            try {
                const auditLogs = await guild.fetchAuditLogs({
                    limit: 1,
                    type: 28 // BOT_ADD
                });
                const botAddLog = auditLogs.entries.first();
                if (botAddLog) {
                    inviter = botAddLog.executor.tag;
                }
            } catch (auditError) {
                console.log('초대자 정보 확인 실패:', auditError.message);
            }

            // 개발자에게 DM 알림
            if (DEVELOPER_ID) {
                try {
                    const developer = await client.users.fetch(DEVELOPER_ID);

                    const alertEmbed = new EmbedBuilder()
                        .setTitle('⚠️ 화이트리스트 외 서버 초대 감지')
                        .setColor(0xFF0000)
                        .addFields(
                            { name: '서버 이름', value: guild.name, inline: true },
                            { name: '서버 ID', value: guild.id, inline: true },
                            { name: '멤버 수', value: `${guild.memberCount}명`, inline: true },
                            { name: '서버 소유자', value: ownerTag, inline: true },
                            { name: '봇 초대자', value: inviter, inline: true },
                            { name: '\u200B', value: '\u200B', inline: true },
                            { name: '조치', value: '서버에 안내 메시지를 보낸 후 자동 퇴장합니다.', inline: false },
                            { name: '승인 방법', value: `\`w!whitelist add ${guild.id}\``, inline: false }
                        )
                        .setTimestamp();

                    await developer.send({ embeds: [alertEmbed] });
                } catch (dmError) {
                    console.error('개발자 DM 전송 실패:', dmError.message);
                }
            }

            // 서버에 메시지 전송
            const channel = guild.channels.cache.find(ch =>
                ch.isTextBased() &&
                ch.permissionsFor(guild.members.me).has('SendMessages') &&
                ch.permissionsFor(guild.members.me).has('EmbedLinks')
            );

            if (channel) {
                const noticeEmbed = new EmbedBuilder()
                    .setTitle('🚫 화이트리스트 미등록 서버')
                    .setDescription(
                        '이 서버는 화이트리스트에 등록되지 않은 서버입니다.\n\n' +
                        '**아래 서버에서 사용 승인을 받아주세요:**\n' +
                        'https://discord.gg/utxeK62GJV \n\n' +
                        '승인 후 다시 초대해주시면 정상적으로 사용하실 수 있습니다.'
                    )
                    .setColor(0xFF0000)
                    .addFields(
                        { name: '📋 승인 절차', value: '1. 지원 서버 참여\n2. 절차에 따라 승인 요청\n3. 승인 대기\n4. 봇 재초대', inline: false }
                    )
                    .setFooter({ text: '잠시 후 자동으로 서버에서 퇴장합니다.' })
                    .setTimestamp();

                await channel.send({ embeds: [noticeEmbed] });

                // 3초 후 퇴장
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            // 서버에서 자동 퇴장
            await guild.leave();
            console.log(`📤 ${guild.name}에서 자동 퇴장 완료`);
            console.log(`   └ 소유자: ${ownerTag}`);
            console.log(`   └ 초대자: ${inviter}`);
            console.log(`   └ 멤버 수: ${guild.memberCount}명`);

        } catch (error) {
            console.error(`자동 퇴장 중 오류 발생 (${guild.name}):`, error);
        }

        return;
    }

    // 화이트리스트에 있는 서버 - 정상 처리
    console.log(`✅ 승인된 서버 추가됨: ${guild.name} (ID: ${guild.id})`);

    // 화이트리스트 정보 업데이트
    await Whitelist.findOneAndUpdate(
        { guildId: guild.id },
        {
            guildName: guild.name,
            memberCount: guild.memberCount
        }
    );
};
