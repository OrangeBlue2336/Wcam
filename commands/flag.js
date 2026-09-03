// commands/flag.js
// 실시간 상태 확인 명령어 (w!flag [구역], 별칭 w!f)
// 별칭 'f'는 아직 index.js에 남아있으며, commands['flag']를 참조해 이 파일로 연결됩니다.

const axios = require('axios');
const sharp = require('sharp');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const fs = require('fs');
const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Setting } = require('../db/models');
const { findZone, getZoneSetting } = require('../utils/helpers');

module.exports = (deps) => async (message, args) => {
    const zoneName = args.join(' ');
    if (!zoneName) return message.reply('❌ 확인할 구역 이름을 입력해주세요. (예: w!flag 독도)');

    const zone = findZone(zoneName);
    if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

    const statusMsg = await message.reply(`🔍 ${zone.name}의 실시간 이미지를 분석 중입니다...`);

    try {
        const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
        const currentFlagBuffer = await sharp(Buffer.from(response.data))
            .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
            .ensureAlpha()
            .toBuffer();

        const currentImg = PNG.sync.read(currentFlagBuffer);
        const originalImg = PNG.sync.read(fs.readFileSync(zone.originalPath));
        const { width, height } = originalImg;
        const diff = new PNG({ width, height });

        const numDiffPixels = pixelmatch(
            originalImg.data, currentImg.data, diff.data, width, height,
            { threshold: 0.1 }
        );

        const totalPixels = width * height;
        const matchPercentage = ((totalPixels - numDiffPixels) / totalPixels) * 100;

        const setting = await Setting.findOne({ guildId: message.guild.id });
        const serverThreshold = getZoneSetting(setting, zone.name, 'threshold') || 90;

        const attachment = new AttachmentBuilder(currentFlagBuffer, { name: 'current_flag.png' });
        const matchPixels = totalPixels - numDiffPixels;

        const buildOriginalEmbed = (matchPct, matchPx, totalPx, diffPx, threshold) =>
            new EmbedBuilder()
                .setTitle(`🖼️ 실시간 감시 화면: ${zone.name}`)
                .setURL(zone.wplaceUrl)
                .addFields(
                    { name: '현재 일치율', value: `**${matchPct.toFixed(2)}%**`, inline: true },
                    { name: '감시 기준', value: `${threshold}%`, inline: true },
                    { name: '픽셀 정보', value: `일치: ${matchPx.toLocaleString()}/${totalPx.toLocaleString()}\n불일치: ${diffPx.toLocaleString()}개`, inline: false }
                )
                .setDescription(
                    matchPct < threshold
                        ? "⚠️ **주의: 현재 태극기가 훼손되었을 가능성이 있습니다!**"
                        : "✅ 현재 일치율이 임계값 이상입니다."
                )
                .setColor(matchPct < threshold ? 0xFF0000 : 0x00FF00)
                .setImage('attachment://current_flag.png')
                .setTimestamp();

        // 오버레이 이미지 생성 함수
        const buildOverlayBuffer = async () => {
            const overlayImg = PNG.sync.read(fs.readFileSync(zone.originalPath));
            const currentImgForOverlay = PNG.sync.read(currentFlagBuffer);
            const overlayPng = new PNG({ width, height });

            for (let i = 0; i < width * height; i++) {
                const idx = i * 4;
                // 현재 이미지 픽셀을 기본으로 사용
                overlayPng.data[idx]     = currentImgForOverlay.data[idx];
                overlayPng.data[idx + 1] = currentImgForOverlay.data[idx + 1];
                overlayPng.data[idx + 2] = currentImgForOverlay.data[idx + 2];
                overlayPng.data[idx + 3] = 255;

                // 참조 이미지와 비교하여 색상 오버레이 적용
                const rDiff = Math.abs(currentImgForOverlay.data[idx]     - overlayImg.data[idx]);
                const gDiff = Math.abs(currentImgForOverlay.data[idx + 1] - overlayImg.data[idx + 1]);
                const bDiff = Math.abs(currentImgForOverlay.data[idx + 2] - overlayImg.data[idx + 2]);
                const isDiff = (rDiff + gDiff + bDiff) > 30; // 임계값 (0.1 * 255 * 3 ≈ 76, 더 느슨하게)

                if (isDiff) {
                    // 불일치: 빨간색 반투명 오버레이
                    overlayPng.data[idx]     = Math.min(255, currentImgForOverlay.data[idx]     * 0.4 + 180);
                    overlayPng.data[idx + 1] = Math.floor(currentImgForOverlay.data[idx + 1] * 0.3);
                    overlayPng.data[idx + 2] = Math.floor(currentImgForOverlay.data[idx + 2] * 0.3);
                } else {
                    // 일치: 초록색 반투명 오버레이
                    overlayPng.data[idx]     = Math.floor(currentImgForOverlay.data[idx]     * 0.3);
                    overlayPng.data[idx + 1] = Math.min(255, currentImgForOverlay.data[idx + 1] * 0.4 + 120);
                    overlayPng.data[idx + 2] = Math.floor(currentImgForOverlay.data[idx + 2] * 0.3);
                }
            }

            return PNG.sync.write(overlayPng);
        };

        // 버튼 생성
        const diffButton = new ButtonBuilder()
            .setCustomId(`flag_diff_${message.id}`)
            .setLabel('🔴 불일치 픽셀 확인')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(diffButton);

        await statusMsg.delete();
        const sentMsg = await message.channel.send({
            embeds: [buildOriginalEmbed(matchPercentage, matchPixels, totalPixels, numDiffPixels, serverThreshold)],
            files: [attachment],
            components: [row]
        });

        // 버튼 인터랙션 처리 (5분 타임아웃)
        const collector = sentMsg.createMessageComponentCollector({ time: 5 * 60 * 1000 });
        let showingOverlay = false;

        collector.on('collect', async (interaction) => {
            await interaction.deferUpdate();

            if (!showingOverlay) {
                // 오버레이 이미지로 전환
                const overlayBuffer = await buildOverlayBuffer();
                const overlayAttachment = new AttachmentBuilder(overlayBuffer, { name: 'current_flag.png' });
                const overlayEmbed = new EmbedBuilder()
                    .setTitle(`🔍 픽셀 일치 현황: ${zone.name}`)
                    .setURL(zone.wplaceUrl)
                    .setDescription('🟢 일치 픽셀 | 🔴 불일치 픽셀')
                    .addFields(
                        { name: '현재 일치율', value: `**${matchPercentage.toFixed(2)}%**`, inline: true },
                        { name: '픽셀 정보', value: `일치: ${matchPixels.toLocaleString()}/${totalPixels.toLocaleString()}\n불일치: ${numDiffPixels.toLocaleString()}개`, inline: false }
                    )
                    .setColor(0x5865F2)
                    .setImage('attachment://current_flag.png')
                    .setTimestamp();

                const backButton = new ButtonBuilder()
                    .setCustomId(`flag_diff_${message.id}`)
                    .setLabel('🖼️ 원본 이미지 보기')
                    .setStyle(ButtonStyle.Secondary);

                await sentMsg.edit({
                    embeds: [overlayEmbed],
                    files: [overlayAttachment],
                    components: [new ActionRowBuilder().addComponents(backButton)]
                });
                showingOverlay = true;
            } else {
                // 원본 이미지로 복원
                const origAttachment = new AttachmentBuilder(currentFlagBuffer, { name: 'current_flag.png' });
                const origButton = new ButtonBuilder()
                    .setCustomId(`flag_diff_${message.id}`)
                    .setLabel('🔴 불일치 픽셀 확인')
                    .setStyle(ButtonStyle.Secondary);

                await sentMsg.edit({
                    embeds: [buildOriginalEmbed(matchPercentage, matchPixels, totalPixels, numDiffPixels, serverThreshold)],
                    files: [origAttachment],
                    components: [new ActionRowBuilder().addComponents(origButton)]
                });
                showingOverlay = false;
            }
        });

        // 5분 후 버튼 비활성화
        collector.on('end', async () => {
            await sentMsg.edit({ components: [] }).catch(() => {});
        });

    } catch (error) {
        console.error(error);
        message.reply('❌ 이미지 분석 중 오류가 발생했습니다.');
    }
};
