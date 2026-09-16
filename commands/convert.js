// commands/convert.js — Blue Marble(.json)과 Wplace Overlay(.wplace) 도안 파일을 상호 변환

const axios = require('axios');
const sharp = require('sharp');
const { AttachmentBuilder } = require('discord.js');

const WPLACE_TILE_COUNT = 2048;
const WPLACE_TILE_PIXELS = 1000;
const BLUE_MARBLE_SCALE = 3;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function mercatorYToLatitude(y) {
    const n = Math.PI * (1 - (2 * y) / WPLACE_TILE_COUNT);
    return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

function latitudeToMercatorY(latitude) {
    const radians = (latitude * Math.PI) / 180;
    return (1 - Math.asinh(Math.tan(radians)) / Math.PI) * WPLACE_TILE_COUNT / 2;
}

function longitudeToMercatorX(longitude) {
    return ((longitude + 180) / 360) * WPLACE_TILE_COUNT;
}

function isBlueMarbleTemplate(data) {
    return data?.whoami === 'BlueMarble' && data?.templates && typeof data.templates === 'object';
}

function isWplaceOverlay(data) {
    return data?.schemaVersion === '1'
        && typeof data?.image?.dataUrl === 'string'
        && data?.bounds
        && typeof data.bounds.north === 'number';
}

function parseTileKey(key) {
    const values = key.split(',').map(value => Number(value.trim()));
    if (values.length !== 4 || values.some(value => !Number.isInteger(value))) {
        throw new Error(`잘못된 Blue Marble 타일 좌표입니다: ${key}`);
    }
    const [tileX, tileY, pixelX, pixelY] = values;
    if (pixelX < 0 || pixelX >= WPLACE_TILE_PIXELS || pixelY < 0 || pixelY >= WPLACE_TILE_PIXELS) {
        throw new Error(`타일 내부 좌표는 0~999여야 합니다: ${key}`);
    }
    return { tileX, tileY, pixelX, pixelY };
}

function base64Png(data) {
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new Error('타일 이미지가 올바른 Base64 PNG 형식이 아닙니다.');
    }
    return Buffer.from(data, 'base64');
}

async function blueMarbleToWplace(data, fallbackName) {
    const templates = Object.values(data.templates);
    if (templates.length !== 1) {
        throw new Error('Blue Marble JSON에는 변환할 도안이 정확히 1개 있어야 합니다.');
    }

    const template = templates[0];
    if (!template?.tiles || typeof template.tiles !== 'object') {
        throw new Error('Blue Marble JSON에서 타일 데이터를 찾을 수 없습니다.');
    }

    const tileEntries = Object.entries(template.tiles);
    if (!tileEntries.length) throw new Error('변환할 타일이 없습니다.');

    const tiles = await Promise.all(tileEntries.map(async ([key, dataUrl]) => {
        const coords = parseTileKey(key);
        const input = base64Png(dataUrl);
        const metadata = await sharp(input).metadata();
        if (!metadata.width || !metadata.height) throw new Error(`타일 크기를 읽을 수 없습니다: ${key}`);
        return {
            ...coords,
            input,
            width: metadata.width,
            height: metadata.height,
            left: coords.tileX * WPLACE_TILE_PIXELS + coords.pixelX,
            top: coords.tileY * WPLACE_TILE_PIXELS + coords.pixelY
        };
    }));

    const originX = Math.min(...tiles.map(tile => tile.left));
    const originY = Math.min(...tiles.map(tile => tile.top));
    const right = Math.max(...tiles.map(tile => tile.left + tile.width / BLUE_MARBLE_SCALE));
    const bottom = Math.max(...tiles.map(tile => tile.top + tile.height / BLUE_MARBLE_SCALE));
    const sourceWidth = Math.round((right - originX) * BLUE_MARBLE_SCALE);
    const sourceHeight = Math.round((bottom - originY) * BLUE_MARBLE_SCALE);

    if (sourceWidth <= 0 || sourceHeight <= 0 || sourceWidth % BLUE_MARBLE_SCALE || sourceHeight % BLUE_MARBLE_SCALE) {
        throw new Error('타일 크기가 Blue Marble의 3배 해상도 규칙과 맞지 않습니다.');
    }

    const source = await sharp({
        create: { width: sourceWidth, height: sourceHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    }).composite(tiles.map(tile => ({
        input: tile.input,
        left: Math.round((tile.left - originX) * BLUE_MARBLE_SCALE),
        top: Math.round((tile.top - originY) * BLUE_MARBLE_SCALE)
    }))).png().toBuffer();

    const width = sourceWidth / BLUE_MARBLE_SCALE;
    const height = sourceHeight / BLUE_MARBLE_SCALE;
    const image = await sharp(source).resize(width, height, { kernel: sharp.kernel.nearest }).png().toBuffer();
    const name = String(template.name || fallbackName).replace(/\.[^.]+$/, '');

    return {
        outputName: `${name}.wplace`,
        output: Buffer.from(JSON.stringify({
            id: crypto.randomUUID(),
            schemaVersion: '1',
            name: `${name}.png`,
            opacity: 0.5,
            image: {
                dataUrl: `data:image/png;base64,${image.toString('base64')}`,
                width,
                height
            },
            bounds: {
                north: mercatorYToLatitude(originY / WPLACE_TILE_PIXELS),
                south: mercatorYToLatitude((originY + height) / WPLACE_TILE_PIXELS),
                west: (originX / WPLACE_TILE_PIXELS) / WPLACE_TILE_COUNT * 360 - 180,
                east: ((originX + width) / WPLACE_TILE_PIXELS) / WPLACE_TILE_COUNT * 360 - 180
            },
            colorMetric: 'lab',
            dithering: false,
            useLegacyColors: false,
            colorPaletteMode: 'all',
            order: 0,
            locked: false,
            hasPlaced: false,
            visible: true
        }, null, 2), 'utf8')
    };
}

async function wplaceToBlueMarble(data, fallbackName) {
    const { bounds } = data;
    const originXFloat = longitudeToMercatorX(bounds.west) * WPLACE_TILE_PIXELS;
    const originYFloat = latitudeToMercatorY(bounds.north) * WPLACE_TILE_PIXELS;
    const originX = Math.round(originXFloat);
    const originY = Math.round(originYFloat);
    if (Math.abs(originXFloat - originX) > 0.001 || Math.abs(originYFloat - originY) > 0.001) {
        throw new Error('Wplace 파일의 시작 좌표가 픽셀 격자에 맞지 않아 Blue Marble로 변환할 수 없습니다.');
    }

    const match = data.image.dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new Error('Wplace 파일의 이미지가 PNG Data URL 형식이 아닙니다.');

    const image = Buffer.from(match[1], 'base64');
    const metadata = await sharp(image).metadata();
    if (!metadata.width || !metadata.height) throw new Error('Wplace 이미지 크기를 읽을 수 없습니다.');

    const scaledWidth = metadata.width * BLUE_MARBLE_SCALE;
    const scaledHeight = metadata.height * BLUE_MARBLE_SCALE;
    const scaledImage = await sharp(image).resize(scaledWidth, scaledHeight, { kernel: sharp.kernel.nearest }).png().toBuffer();
    const tiles = {};

    const endX = originX + metadata.width;
    const endY = originY + metadata.height;
    for (let top = originY; top < endY;) {
        const tileY = Math.floor(top / WPLACE_TILE_PIXELS);
        const pixelY = top % WPLACE_TILE_PIXELS;
        const worldHeight = Math.min(WPLACE_TILE_PIXELS - pixelY, endY - top);
        for (let left = originX; left < endX;) {
            const tileX = Math.floor(left / WPLACE_TILE_PIXELS);
            const pixelX = left % WPLACE_TILE_PIXELS;
            const worldWidth = Math.min(WPLACE_TILE_PIXELS - pixelX, endX - left);
            const tile = await sharp(scaledImage)
                .extract({
                    left: (left - originX) * BLUE_MARBLE_SCALE,
                    top: (top - originY) * BLUE_MARBLE_SCALE,
                    width: worldWidth * BLUE_MARBLE_SCALE,
                    height: worldHeight * BLUE_MARBLE_SCALE
                })
                .png()
                .toBuffer();
            const key = `${tileX},${tileY},${String(pixelX).padStart(3, '0')},${String(pixelY).padStart(3, '0')}`;
            tiles[key] = tile.toString('base64');
            left += worldWidth;
        }
        top += worldHeight;
    }

    const raw = await sharp(scaledImage).ensureAlpha().raw().toBuffer();
    let validPixelCount = 0;
    for (let index = 3; index < raw.length; index += 4) {
        if (raw[index] !== 0) validPixelCount += 1;
    }

    const name = String(data.name || fallbackName).replace(/\.[^.]+$/, '');
    const totalPixels = scaledWidth * scaledHeight;
    const now = new Date().toISOString();
    const template = {
        name,
        coords: `${Math.floor(originX / WPLACE_TILE_PIXELS)}, ${Math.floor(originY / WPLACE_TILE_PIXELS)}, ${originX % WPLACE_TILE_PIXELS}, ${originY % WPLACE_TILE_PIXELS}`,
        createdAt: now,
        pixelCount: totalPixels,
        validPixelCount,
        transparentPixelCount: totalPixels - validPixelCount,
        enabled: true,
        disabledColors: [],
        enhancedColors: [],
        tiles
    };

    return {
        outputName: `${name}.json`,
        output: Buffer.from(JSON.stringify({
            whoami: 'BlueMarble',
            scriptVersion: '1.0.1',
            schemaVersion: '1.0.0',
            createdAt: now,
            lastModified: now,
            templateCount: 1,
            totalPixels,
            templates: { [`0 ${Date.now()}`]: template }
        }, null, 2), 'utf8')
    };
}

module.exports = (deps) => async (message) => {
    const attachment = message.attachments.first();
    if (!attachment) {
        return message.reply('❌ 변환할 `.json` 또는 `.wplace` 파일을 첨부한 뒤 `w!convert`를 입력해주세요.');
    }
    if (attachment.size > MAX_INPUT_BYTES) {
        return message.reply('❌ 첨부 파일은 8MB 이하여야 합니다.');
    }

    try {
        const response = await axios.get(attachment.url, { responseType: 'arraybuffer', maxContentLength: MAX_INPUT_BYTES });
        const input = Buffer.from(response.data);
        if (input.length > MAX_INPUT_BYTES) return message.reply('❌ 첨부 파일은 8MB 이하여야 합니다.');

        const data = JSON.parse(input.toString('utf8'));
        const fallbackName = attachment.name.replace(/\.[^.]+$/, '');
        const result = isBlueMarbleTemplate(data)
            ? await blueMarbleToWplace(data, fallbackName)
            : isWplaceOverlay(data)
                ? await wplaceToBlueMarble(data, fallbackName)
                : null;

        if (!result) {
            return message.reply('❌ Blue Marble `.json` 또는 Wplace Overlay `.wplace` 형식을 확인할 수 없습니다.');
        }
        if (result.output.length > 8 * 1024 * 1024) {
            return message.reply('❌ 변환 결과가 8MB를 넘어 Discord에 첨부할 수 없습니다.');
        }

        await message.reply({
            content: `✅ 변환 완료: \`${result.outputName}\``,
            files: [new AttachmentBuilder(result.output, { name: result.outputName })]
        });
    } catch (error) {
        console.error('convert 오류:', error);
        return message.reply(`❌ 변환하지 못했습니다: ${error.message || '파일 형식을 확인해주세요.'}`);
    }
};
