// commands/record.js — 녹화(타임랩스) 명령어 (w!record, 별칭 w!r). 22개 명령어 중 가장 큼.
// services/recording.js가 관리하는 공유 상태(pendingArtworkRecords 등)를 index.js가 만든 단일 인스턴스로 deps 주입받아,
// events/interactionCreate.js(버튼 처리)와 같은 데이터를 바라보게 함

const axios = require('axios');
const sharp = require('sharp');
const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { RecordSession, RecordFrame } = require('../db/models');
const monitorZones = require('../config/zones');
const { findZone, parseDuration, durationToKorean, generateSessionId } = require('../utils/helpers');
const { MAX_RECORD_DURATION_MS, DEVELOPER_ID } = require('../config/env');

module.exports = (deps) => async (message, args) => {
    const { captureRegionBuffer, finalizeRecord, cleanupRecord, pendingArtworkRecords } = deps;

    // w!record test (개발자 전용 스트레스 테스트)
    if (args[0] === 'test') {
        if (message.author.id !== DEVELOPER_ID) {
            return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
        }

        // 기존 테스트 세션 잔여물 정리
        await cleanupRecord(message.author.id, 'flag');

        const statusMsg = await message.reply('🧪 **[녹화 스트레스 테스트]** 독도 태극기 프레임 캡처 중...');

        try {
            const zone = monitorZones.find(z => z.name === '독도 태극기');
            if (!zone) return statusMsg.edit('❌ 독도 태극기 구역을 찾을 수 없습니다.');

            // ① 현재 독도 태극기 프레임 1장 캡처
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            const frameBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .toBuffer();

            await statusMsg.edit('🧪 **[녹화 스트레스 테스트]** 프레임 2880장 DB 저장 중...');

            // ② RecordSession 생성 (이미 완료된 상태로)
            await new RecordSession({
                userId: message.author.id,
                sessionType: 'flag',
                sessionId: generateSessionId(),
                zoneName: zone.name,
                frameCount: 2880,
                endTime: new Date(),
                isActive: false,
                commandChannelId: message.channel.id,
                statusChannelId: message.channel.id,
                statusMessageId: statusMsg.id
            }).save();

            // ③ 프레임 2880장 배치 삽입 (100개씩)
            const TEST_FRAME_COUNT = 2880;
            const BATCH_SIZE = 100;
            const baseTime = new Date();
            let inserted = 0;

            for (let i = 0; i < TEST_FRAME_COUNT; i += BATCH_SIZE) {
                const batch = [];
                const end = Math.min(i + BATCH_SIZE, TEST_FRAME_COUNT);
                for (let j = i; j < end; j++) {
                    batch.push({
                        userId: message.author.id,
                        sessionType: 'flag',
                        frameData: frameBuffer,
                        timestamp: new Date(baseTime.getTime() + j * 30000) // 30초 간격 시뮬레이션
                    });
                }
                await RecordFrame.insertMany(batch);
                inserted += batch.length;

                // 500장마다 진행상황 업데이트
                if (inserted % 500 === 0 || inserted === TEST_FRAME_COUNT) {
                    await statusMsg.edit(`🧪 **[녹화 스트레스 테스트]** 프레임 저장 중... (${inserted}/${TEST_FRAME_COUNT})`);
                }
            }

            await statusMsg.edit('🧪 **[녹화 스트레스 테스트]** 저장 완료! 인코딩 큐에 추가합니다...');
            console.log(`🧪 [TEST] ${message.author.id} - 테스트 프레임 2880장 저장 완료, 인코딩 시작`);

            // ④ 실제 녹화와 동일하게 인코딩 실행
            await finalizeRecord(message.author.id, 'flag');

        } catch (err) {
            console.error('record test 오류:', err);
            await statusMsg.edit(`❌ 테스트 중 오류 발생: ${err.message}`);
        }
        return;
    }
    // w!record recover (ID) - 오류로 중단된 녹화 복구
    if (args[0] === 'recover') {
        const targetId = (args[1] || '').trim().toUpperCase();
        if (!targetId) {
            return message.reply("❌ 사용법: `w!record recover (ID)`\n(ID는 오류 발생 시 상태 메시지에 안내된 코드입니다)");
        }

        // 본인이 시작한 녹화만 복구 가능 (userId가 일치하지 않으면 조회 자체가 안 됨 → 타인 영상이 전송될 수 없음)
        const session = await RecordSession.findOne({
            userId: message.author.id,
            sessionId: targetId,
            needsRecovery: true
        });

        if (!session) {
            return message.reply(`❌ ID \`${targetId}\`에 해당하는, 본인이 시작한 복구 대기 중인 녹화를 찾을 수 없습니다.`);
        }

        const frameCount = await RecordFrame.countDocuments({ userId: message.author.id, sessionType: session.sessionType });
        if (frameCount === 0) {
            return message.reply(`❌ 복구할 프레임이 남아있지 않습니다. (ID: \`${targetId}\`)`);
        }

        const statusMsg = await message.reply(
            `🔁 복구를 시작합니다. (ID: \`${targetId}\`, 프레임 ${frameCount}개)\n` +
            `이 메시지가 진행 상황/완료 안내로 갱신됩니다.`
        );
        await RecordSession.updateOne(
            { _id: session._id },
            { needsRecovery: false, statusChannelId: message.channel.id, statusMessageId: statusMsg.id }
        );
        finalizeRecord(session.userId, session.sessionType);
        return;
    }

    // w!record stop - 진행 중인 녹화 중지
    if (args[0] === 'stop') {
        const sessions = await RecordSession.find({ userId: message.author.id, isActive: true });

        if (sessions.length === 0) {
            return message.reply("❌ 현재 진행 중인 녹화가 없습니다.");
        }

        const artworkSession = sessions.find(s => s.sessionType === 'artwork');
        const flagSession    = sessions.find(s => s.sessionType === 'flag');

        // 두 가지 녹화 동시 진행 중 → 선택지 제공
        if (artworkSession && flagSession) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`stop_select_artwork_${message.author.id}`)
                    .setLabel('🎨 작품 타임랩스')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`stop_select_flag_${message.author.id}`)
                    .setLabel('🚩 태극기 녹화')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`stop_select_cancel_${message.author.id}`)
                    .setLabel('취소')
                    .setStyle(ButtonStyle.Danger)
            );
            return message.reply({
                content: "⏺️ 현재 두 개의 녹화가 진행 중입니다. 중지할 녹화를 선택해주세요.",
                components: [row]
            });
        }

        // 작품 녹화만 진행 중
        if (artworkSession) {
            const frameCount = artworkSession.frameCount || 0;
            const confirmEmbed = new EmbedBuilder()
                .setTitle("🎨 작품 타임랩스 중단 확인")
                .setDescription(
                    `현재까지 **${frameCount}/2880** 프레임이 녹화되었습니다.\n\n` +
                    `정말 녹화를 중지하시겠습니까?\n` +
                    `중지하면 지금까지 녹화된 영상이 DM으로 전송됩니다.`
                )
                .setColor(0xFFA500);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`confirm_stop_artwork_${message.author.id}`).setLabel('✅ 중지').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`cancel_stop_record_${message.author.id}`).setLabel('취소').setStyle(ButtonStyle.Secondary)
            );
            return message.reply({ embeds: [confirmEmbed], components: [row] });
        }

        // 태극기 녹화만 진행 중
        if (flagSession) {
            const frameCount = flagSession.frameCount || 0;
            const confirmEmbed = new EmbedBuilder()
                .setTitle("🎥 태극기 녹화 중단 확인")
                .setDescription(
                    `현재까지 **${frameCount}** 프레임이 녹화되었습니다.\n\n` +
                    `정말 녹화를 중지하시겠습니까?\n` +
                    `지금까지 녹화된 이미지는 MP4로 변환되어 DM으로 전송됩니다.`
                )
                .setColor(0xFFA500);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('confirm_stop_record').setLabel('확인').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('cancel_stop_record').setLabel('취소').setStyle(ButtonStyle.Secondary)
            );
            return message.reply({ embeds: [confirmEmbed], components: [row] });
        }
        return;
    }

    // w!record (tileX) (tileY) (localX) (localY) + 첨부 이미지
    // 첫 번째 인자가 숫자이면 작품 녹화
    if (!isNaN(parseInt(args[0]))) {
        if (args.length < 4) {
            return message.reply(
                "❌ 사용법: `w!record (타일X) (타일Y) (로컬X) (로컬Y)` + 도안 이미지 첨부\n" +
                "예: `w!record 100 200 500 300` (도안 이미지 함께 첨부 필수)\n\n" +
                "녹화 중지/상태 확인: `w!record stop`"
            );
        }

        const tileX  = parseInt(args[0]);
        const tileY  = parseInt(args[1]);
        const localX = Math.max(0, Math.min(999, parseInt(args[2])));
        const localY = Math.max(0, Math.min(999, parseInt(args[3])));

        if ([tileX, tileY, localX, localY].some(isNaN)) {
            return message.reply("❌ 좌표는 모두 숫자로 입력해주세요.");
        }

        const imgAttachment = message.attachments.first();
        if (!imgAttachment || !imgAttachment.contentType?.startsWith('image/')) {
            return message.reply("❌ 도안 이미지를 함께 첨부해주세요. (PNG, JPG 등)");
        }

        const existingArtwork = await RecordSession.findOne({
            userId: message.author.id, sessionType: 'artwork', isActive: true
        });
        if (existingArtwork) {
            return message.reply("❌ 이미 작품 타임랩스 녹화가 진행 중입니다. `w!record stop`으로 먼저 중지해주세요.");
        }

        const recoveryPendingArtwork = await RecordSession.findOne({
            userId: message.author.id, sessionType: 'artwork', needsRecovery: true
        });
        if (recoveryPendingArtwork) {
            return message.reply(
                `❌ 이전 작품 녹화(ID: \`${recoveryPendingArtwork.sessionId}\`)가 영상 생성 중 오류로 중단되어 복구 대기 중입니다.\n` +
                `먼저 \`w!record recover ${recoveryPendingArtwork.sessionId}\` 명령어로 복구를 시도해주세요.`
            );
        }

        const statusMsg = await message.reply("🔍 도안을 분석하고 미리보기를 준비하는 중...");

        try {
            // 도안 이미지 크기 파악
            const designRes  = await axios.get(imgAttachment.url, { responseType: 'arraybuffer' });
            const designMeta = await sharp(Buffer.from(designRes.data)).metadata();
            const captureWidth  = designMeta.width;
            const captureHeight = designMeta.height;

            // wplace 해당 영역 실시간 캡처 (미리보기)
            const previewBuffer     = await captureRegionBuffer(tileX, tileY, localX, localY, captureWidth, captureHeight);
            const previewAttachment = new AttachmentBuilder(previewBuffer, { name: 'preview.png' });

            const embed = new EmbedBuilder()
                .setTitle("🎨 작품 타임랩스 - 녹화 영역 확인")
                .setDescription(
                    `**위치:** 타일 (${tileX}, ${tileY}), 로컬 (${localX}, ${localY})\n` +
                    `**캡처 크기:** ${captureWidth} × ${captureHeight} 픽셀\n\n` +
                    `위 영역으로 녹화를 시작할까요?\n` +
                    `📌 30초마다 캡처하며, 변화가 없으면 자동으로 건너뜁니다.\n` +
                    `📌 최대 **2880 프레임** 도달 시 자동 종료됩니다.\n` +
                    `📌 기본 배경색은 바다색으로 설정됩니다.`
                )
                .setColor(0x0099FF)
                .setImage('attachment://preview.png')
                .setTimestamp();

            // 대기 중인 세션 임시 저장 (버튼 확인 대기용)
            pendingArtworkRecords.set(message.author.id, {
                tileX, tileY, localX, localY, captureWidth, captureHeight
            });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_start_artwork_${message.author.id}`)
                    .setLabel('✅ 녹화 시작')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`cancel_start_artwork_${message.author.id}`)
                    .setLabel('❌ 취소')
                    .setStyle(ButtonStyle.Danger)
            );

            await statusMsg.delete();
            await message.channel.send({ embeds: [embed], files: [previewAttachment], components: [row] });

        } catch (err) {
            console.error('record(작품) 오류:', err);
            await statusMsg.edit(`❌ 미리보기 생성 실패: ${err.message}`);
        }
        return;
    }

    // w!record (지역) (시간) - 태극기 녹화
    if (args.length < 2) {
        return message.reply(
            "❌ 사용법:\n" +
            "• 작품 타임랩스: `w!record (타일X) (타일Y) (로컬X) (로컬Y)` + 도안 이미지 첨부\n" +
            "• 태극기 녹화: `w!record (지역) (시간)` (예: `w!record 독도 30m`)\n" +
            "• 녹화 중지: `w!record stop`"
        );
    }

    const zone = findZone(args[0]);
    if (!zone) return message.reply(`❌ '${args[0]}' 구역을 찾을 수 없습니다.`);

    const durationMs = parseDuration(args[1]);
    if (!durationMs || durationMs <= 0 || durationMs > MAX_RECORD_DURATION_MS) {
        return message.reply("❌ 시간 형식이 잘못되었거나 범위를 초과했습니다. (최대 24시간)");
    }

    const existingFlag = await RecordSession.findOne({ userId: message.author.id, sessionType: 'flag', isActive: true });
    if (existingFlag) return message.reply("❌ 이미 태극기 녹화를 진행 중입니다.");

    const recoveryPendingFlag = await RecordSession.findOne({ userId: message.author.id, sessionType: 'flag', needsRecovery: true });
    if (recoveryPendingFlag) {
        return message.reply(
            `❌ 이전 녹화(ID: \`${recoveryPendingFlag.sessionId}\`)가 영상 생성 중 오류로 중단되어 복구 대기 중입니다.\n` +
            `먼저 \`w!record recover ${recoveryPendingFlag.sessionId}\` 명령어로 복구를 시도해주세요.`
        );
    }

    const endTime = new Date(Date.now() + durationMs);
    await new RecordSession({
        userId: message.author.id,
        sessionType: 'flag',
        sessionId: generateSessionId(),
        zoneName: zone.name,
        endTime: endTime,
        isActive: true,
        commandChannelId: message.channel.id
    }).save();

    try {
        const endUnix = Math.floor(endTime.getTime() / 1000);
        const koreanDuration = durationToKorean(args[1]);
        await message.author.send(
            `⏺️ **${zone.name}** 녹화가 시작되었습니다.\n` +
            `⏱️ **녹화 기간:** ${koreanDuration}\n` +
            `⏳ **종료 예정:** <t:${endUnix}:R> (<t:${endUnix}:f>)\n\n` +
            `종료 후 MP4 영상이 이곳으로 전송됩니다.`
        );
        message.reply(`${koreanDuration} 동안 **${zone.name}** 녹화를 진행합니다. 녹화 시작 DM을 전송하였습니다.`);
    } catch (e) {
        await cleanupRecord(message.author.id, 'flag');
        return message.reply("❌ DM을 보낼 수 없습니다. DM 설정을 확인해주세요.");
    }
};
