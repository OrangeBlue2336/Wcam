// events/interactionCreate.js — 녹화 시작/중지 버튼(작품 타임랩스, 태극기) 처리.
// captureRegionBuffer/finalizeRecord/pendingArtworkRecords는 commands/record.js와 같은 단일 인스턴스를 deps로 받아야
// "녹화 시작 확인" 버튼을 눌렀을 때 record.js가 만든 대기 세션을 정상적으로 찾을 수 있음

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { RecordSession, RecordFrame } = require('../db/models');
const { generateSessionId } = require('../utils/helpers');

module.exports = (deps) => {
    const { captureRegionBuffer, finalizeRecord, pendingArtworkRecords } = deps;

    return async (interaction) => {
        if (!interaction.isButton()) return;
        const cid    = interaction.customId;
        const userId = interaction.user.id;

        // 작품 녹화 시작 확인 버튼
        if (cid === `confirm_start_artwork_${userId}`) {

            // 버튼을 누른 시점에 DB를 2차로 확인하여 이미 녹화가 시작된 경우 중복 시작 방지
            const existingArtwork = await RecordSession.findOne({
                userId, sessionType: 'artwork', isActive: true
            });
            if (existingArtwork) {
                pendingArtworkRecords.delete(userId); // 찌꺼기 정리
                return interaction.update({
                    content: "❌ 이미 작품 타임랩스 녹화가 진행 중입니다. 기존 녹화를 먼저 중지해주세요.",
                    embeds: [], components: []
                });
            }

            const recoveryPendingArtwork = await RecordSession.findOne({
                userId, sessionType: 'artwork', needsRecovery: true
            });
            if (recoveryPendingArtwork) {
                pendingArtworkRecords.delete(userId);
                return interaction.update({
                    content:
                        `❌ 이전 작품 녹화(ID: \`${recoveryPendingArtwork.sessionId}\`)가 영상 생성 중 오류로 중단되어 복구 대기 중입니다.\n` +
                        `먼저 \`w!record recover ${recoveryPendingArtwork.sessionId}\` 명령어로 복구를 시도해주세요.`,
                    embeds: [], components: []
                });
            }

            const pending = pendingArtworkRecords.get(userId);
            if (!pending) {
                return interaction.update({ content: "❌ 세션이 만료되었습니다. 다시 `w!record` 명령어를 실행해주세요.", embeds: [], components: [] });
            }
            pendingArtworkRecords.delete(userId);

            const { tileX, tileY, localX, localY, captureWidth, captureHeight } = pending;

            await new RecordSession({
                userId, sessionType: 'artwork',
                sessionId: generateSessionId(),
                tileX, tileY, localX, localY, captureWidth, captureHeight,
                isActive: true,
                commandChannelId: interaction.channelId
            }).save();

            // 최초 1번 프레임 즉시 저장
            try {
                const firstFrame = await captureRegionBuffer(tileX, tileY, localX, localY, captureWidth, captureHeight);
                await new RecordFrame({ userId, sessionType: 'artwork', frameData: firstFrame }).save();
                await RecordSession.updateOne({ userId, sessionType: 'artwork', isActive: true }, { frameCount: 1 });
            } catch (e) {
                console.error('첫 프레임 저장 오류:', e);
            }

            await interaction.update({
                content:
                    "⏺️ **작품 타임랩스 녹화가 시작되었습니다!**\n\n" +
                    "📌 **안내:**\n" +
                    "• 30초마다 변화를 감지하여 프레임을 저장합니다.\n" +
                    "• 변화가 없으면 해당 프레임은 자동으로 건너뜁니다.\n" +
                    "• 최대 **2880 프레임** 도달 시 자동 종료됩니다.\n" +
                    "• `w!record stop` 으로 현재 프레임 수 확인 및 중지 가능합니다.\n\n" +
                    "녹화 완료 시 DM으로 MP4 타임랩스 영상을 전송해드립니다. 🎬",
                embeds: [], files: [], components: []
            });
            return;
        }

        if (cid === `cancel_start_artwork_${userId}`) {
        pendingArtworkRecords.delete(userId);
        await interaction.update({
            content: "❌ 녹화가 취소되었습니다.",
            embeds: [],
            files: [],
            attachments: [],
            components: []
        });
        return;
        }

        // 작품 녹화 중지 확인
        if (cid === `confirm_stop_artwork_${userId}`) {
            await interaction.update({ content: "⏹️ 녹화를 중지하고 영상을 생성합니다...", embeds: [], components: [] });
            // 이 메시지를 상태 메시지로 등록 → 이후 완료/오류 안내를 DM 대신 이 메시지 수정으로 전달
            await RecordSession.updateOne(
                { userId, sessionType: 'artwork', isActive: true },
                { isActive: false, statusChannelId: interaction.channelId, statusMessageId: interaction.message.id }
            );
            await finalizeRecord(userId, 'artwork');
            return;
        }

        // 두 개 동시 진행 → 선택 버튼
        if (cid === `stop_select_artwork_${userId}`) {
            const s = await RecordSession.findOne({ userId, sessionType: 'artwork', isActive: true });
            if (!s) return interaction.update({ content: "❌ 진행 중인 작품 녹화를 찾을 수 없습니다.", embeds: [], components: [] });
            const fc = s.frameCount || 0;
            const embed = new EmbedBuilder()
                .setTitle("🎨 작품 타임랩스 중단 확인")
                .setDescription(`현재까지 **${fc}/2880** 프레임 녹화됨.\n정말 중지하시겠습니까?`)
                .setColor(0xFFA500);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`confirm_stop_artwork_${userId}`).setLabel('✅ 중지').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`cancel_stop_record_${userId}`).setLabel('취소').setStyle(ButtonStyle.Secondary)
            );
            await interaction.update({ content: null, embeds: [embed], components: [row] });
            return;
        }

        if (cid === `stop_select_flag_${userId}`) {
            const s = await RecordSession.findOne({ userId, sessionType: 'flag', isActive: true });
            if (!s) return interaction.update({ content: "❌ 진행 중인 태극기 녹화를 찾을 수 없습니다.", embeds: [], components: [] });
            const fc = s.frameCount || 0;
            const embed = new EmbedBuilder()
                .setTitle("🚩 태극기 녹화 중단 확인")
                .setDescription(`현재까지 **${fc}** 프레임 녹화됨.\n정말 중지하시겠습니까?`)
                .setColor(0xFFA500);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('confirm_stop_record').setLabel('✅ 중지').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`cancel_stop_record_${userId}`).setLabel('취소').setStyle(ButtonStyle.Secondary)
            );
            await interaction.update({ content: null, embeds: [embed], components: [row] });
            return;
        }

        if (cid === `stop_select_cancel_${userId}`) {
            await interaction.update({ content: "⏺️ 녹화 계속 진행", embeds: [], components: [] });
            return;
        }

        // 기존 태극기 녹화 중지 확인 (하위 호환 유지)
        if (cid === 'confirm_stop_record') {
            await interaction.update({ content: "✅ 녹화 중단됨", embeds: [], components: [] });
            // 이 메시지를 상태 메시지로 등록 → 이후 완료/오류 안내를 DM 대신 이 메시지 수정으로 전달
            await RecordSession.updateOne(
                { userId, sessionType: 'flag', isActive: true },
                { isActive: false, statusChannelId: interaction.channelId, statusMessageId: interaction.message.id }
            );
            await finalizeRecord(userId, 'flag');
            return;
        }

        if (cid === 'cancel_stop_record' || cid === `cancel_stop_record_${userId}`) {
            await interaction.update({ content: "⏺️ 녹화 계속 진행", embeds: [], components: [] });
            return;
        }
    };
};
