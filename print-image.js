
'use strict';

/*
 * print-image.js
 *
 * Print PNG images on a HOLYHAH 3B-365B TSPL-compatible label printer.
 *
 * Project requirements:
 *   - Node.js
 *   - sharp
 *   - dotenv
 *   - ./usb-printer-transport.js exporting writePrinter(device, data)
 *
 * Default label:
 *   Width:  51 mm
 *   Height: 30 mm
 *   Gap:     2 mm
 *   DPI:   203
 *
 * Alignment:
 *   --offset-dots       Horizontal offset (X), in printer dots.
 *   --offset-y-dots     Vertical offset (Y), in printer dots.
 *
 * Positive X moves right; negative X moves left.
 * Positive Y moves down; negative Y moves up.
 *
 * Note: pixels shifted beyond the raster boundaries are clipped.
 */

const path = require('node:path');
const fs = require('node:fs/promises');

require('dotenv').config({
    path: path.join(__dirname, '.env'),
});

const sharp = require('sharp');

const {
    writePrinter,
} = require('./usb-printer-transport');


/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const CONFIG = Object.freeze({
    device:
        process.env.LABEL_PRINTER_DEVICE ||
        '/dev/holyhah-label',

    widthMm:
        Number(process.env.LABEL_WIDTH_MM || 51),

    heightMm:
        Number(process.env.LABEL_HEIGHT_MM || 30),

    gapMm:
        Number(process.env.LABEL_GAP_MM || 2),

    dpi:
        Number(process.env.LABEL_DPI || 203),

    speed:
        Number(process.env.LABEL_SPEED || 5),

    density:
        Number(process.env.LABEL_DENSITY || 7),

    threshold:
        Number(
            process.env.LABEL_IMAGE_THRESHOLD ||
            process.env.LABEL_LOGO_THRESHOLD ||
            180
        ),

    horizontalOffsetDots:
        Number(process.env.LABEL_HORIZONTAL_OFFSET_DOTS || 0),

    verticalOffsetDots:
        Number(process.env.LABEL_VERTICAL_OFFSET_DOTS || 0),
});

const WHITE = 255;
const BLACK = 0;


/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function printHelp() {
    console.log(`
HOLYHAH PNG Label Printer

Usage:
  node print-image.js --image ./assets/artwork.png
  node print-image.js ./assets/artwork.png [options]

Required:
  -i, --image PATH
      Path to the source PNG image.

Options:
  -c, --copies NUMBER
      Number of copies to print. Default: 1.

      --width-mm NUMBER
      Label width in millimeters. Default: ${CONFIG.widthMm}.

      --height-mm NUMBER
      Label height in millimeters. Default: ${CONFIG.heightMm}.

      --gap-mm NUMBER
      Label gap in millimeters. Default: ${CONFIG.gapMm}.

      --fit MODE
      Image resizing mode: contain, cover, or fill.
      Default: contain.

      --threshold NUMBER
      Black/white threshold from 0 to 255.
      Default: ${CONFIG.threshold}.

      --no-dither
      Disable dithering and use threshold conversion.

      --dither
      Enable Floyd-Steinberg dithering. Default: enabled.

      --offset-dots NUMBER
      Horizontal image offset in dots.
      Positive = right; negative = left.
      Default: ${CONFIG.horizontalOffsetDots}.

      --offset-y-dots NUMBER
      Vertical image offset in dots.
      Positive = down; negative = up.
      Default: ${CONFIG.verticalOffsetDots}.

      --preview PATH
      Save a monochrome preview at label resolution.

      --preview-only
      Generate the preview without printing.

  -h, --help
      Show this help.

Examples:

  # Print one image
  node print-image.js --image ./assets/artwork.png

  # Move the image 1 mm to the right
  node print-image.js --image ./assets/artwork.png --offset-dots 8

  # Move the image 1 mm down
  node print-image.js --image ./assets/artwork.png --offset-y-dots 8

  # Move right 1 mm and up 0.5 mm
  node print-image.js --image ./assets/artwork.png \\
      --offset-dots 8 --offset-y-dots -4

  # Print two copies
  node print-image.js --image ./assets/artwork.png --copies 2

  # Preview without printing
  node print-image.js --image ./assets/artwork.png \\
      --preview ./assets/label-preview.png --preview-only
`);
}


function parseArguments(argv) {
    const options = {
        image: null,

        copies: 1,

        widthMm: CONFIG.widthMm,
        heightMm: CONFIG.heightMm,
        gapMm: CONFIG.gapMm,

        fit: 'contain',

        threshold: CONFIG.threshold,
        dither: true,

        offsetDots: CONFIG.horizontalOffsetDots,
        offsetYDots: CONFIG.verticalOffsetDots,

        preview: null,
        previewOnly: false,

        help: false,
    };

    const valueOptions = new Map([
        ['image', 'image'],
        ['copies', 'copies'],
        ['width-mm', 'widthMm'],
        ['height-mm', 'heightMm'],
        ['gap-mm', 'gapMm'],
        ['fit', 'fit'],
        ['threshold', 'threshold'],
        ['offset-dots', 'offsetDots'],
        ['offset-y-dots', 'offsetYDots'],
        ['preview', 'preview'],
    ]);

    const positional = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === '--') {
            positional.push(...argv.slice(i + 1));
            break;
        }

        if (arg === '-h' || arg === '--help') {
            options.help = true;
            continue;
        }

        if (arg === '-i' || arg === '-c') {
            const next = argv[i + 1];

            if (next === undefined || next.startsWith('-')) {
                throw new Error(`Option ${arg} requires a value.`);
            }

            if (arg === '-i') {
                options.image = next;
            } else {
                options.copies = next;
            }

            i += 1;
            continue;
        }

        if (arg === '--preview-only') {
            options.previewOnly = true;
            continue;
        }

        if (arg === '--no-dither') {
            options.dither = false;
            continue;
        }

        if (arg === '--dither') {
            options.dither = true;
            continue;
        }

        if (arg.startsWith('--')) {
            const equalsIndex = arg.indexOf('=');

            const optionName = arg.slice(
                2,
                equalsIndex === -1 ? undefined : equalsIndex
            );

            const key = valueOptions.get(optionName);

            if (!key) {
                throw new Error(`Unknown option: ${arg}`);
            }

            let value;

            if (equalsIndex !== -1) {
                value = arg.slice(equalsIndex + 1);
            } else {
                value = argv[i + 1];

                if (
                    value === undefined ||
                    value.startsWith('--')
                ) {
                    throw new Error(
                        `Option --${optionName} requires a value.`
                    );
                }

                i += 1;
            }

            options[key] = value;
            continue;
        }

        if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        }

        positional.push(arg);
    }

    if (!options.image && positional.length > 0) {
        options.image = positional.shift();
    }

    if (positional.length > 0) {
        throw new Error(
            `Unexpected positional argument: ${positional[0]}`
        );
    }

    options.copies = Number(options.copies);
    options.widthMm = Number(options.widthMm);
    options.heightMm = Number(options.heightMm);
    options.gapMm = Number(options.gapMm);
    options.threshold = Number(options.threshold);
    options.offsetDots = Number(options.offsetDots);
    options.offsetYDots = Number(options.offsetYDots);

    return options;
}


/* -------------------------------------------------------------------------- */
/* Validation and dimensions                                                  */
/* -------------------------------------------------------------------------- */

function mmToDots(mm, dpi = CONFIG.dpi) {
    return Math.round(Number(mm) * dpi / 25.4);
}


function validateOptions(options) {
    if (!options.image) {
        throw new Error(
            'Provide an image using --image PATH.'
        );
    }

    if (options.previewOnly && !options.preview) {
        throw new Error(
            '--preview-only requires --preview PATH.'
        );
    }

    if (
        !Number.isInteger(options.copies) ||
        options.copies < 1 ||
        options.copies > 100
    ) {
        throw new Error(
            '--copies must be an integer between 1 and 100.'
        );
    }

    if (
        !Number.isFinite(options.widthMm) ||
        options.widthMm < 20 ||
        options.widthMm > 80
    ) {
        throw new Error(
            '--width-mm must be between 20 and 80 mm.'
        );
    }

    if (
        !Number.isFinite(options.heightMm) ||
        options.heightMm <= 0 ||
        options.heightMm > 300
    ) {
        throw new Error(
            '--height-mm must be greater than 0 and no more than 300 mm.'
        );
    }

    if (
        !Number.isFinite(options.gapMm) ||
        options.gapMm < 0 ||
        options.gapMm > 20
    ) {
        throw new Error(
            '--gap-mm must be between 0 and 20 mm.'
        );
    }

    if (!['contain', 'cover', 'fill'].includes(options.fit)) {
        throw new Error(
            '--fit must be contain, cover, or fill.'
        );
    }

    if (
        !Number.isFinite(options.threshold) ||
        options.threshold < 0 ||
        options.threshold > 255
    ) {
        throw new Error(
            '--threshold must be between 0 and 255.'
        );
    }

    if (!Number.isInteger(options.offsetDots)) {
        throw new Error(
            '--offset-dots must be an integer.'
        );
    }

    if (!Number.isInteger(options.offsetYDots)) {
        throw new Error(
            '--offset-y-dots must be an integer.'
        );
    }

    if (!Number.isFinite(CONFIG.dpi) || CONFIG.dpi <= 0) {
        throw new Error(
            'LABEL_DPI must be a positive number.'
        );
    }

    if (!Number.isFinite(CONFIG.speed) || CONFIG.speed <= 0) {
        throw new Error(
            'LABEL_SPEED must be a positive number.'
        );
    }

    if (
        !Number.isFinite(CONFIG.density) ||
        CONFIG.density < 0 ||
        CONFIG.density > 15
    ) {
        throw new Error(
            'LABEL_DENSITY must be between 0 and 15.'
        );
    }
}


/* -------------------------------------------------------------------------- */
/* Independent X-axis shifting                                                */
/* -------------------------------------------------------------------------- */

/*
 * Shift image content horizontally within the label raster.
 *
 * Positive offsetDots moves right.
 * Negative offsetDots moves left.
 *
 * Areas without image content are filled white.
 * Pixels shifted beyond the raster are clipped.
 */

function shiftGrayscaleHorizontally(
    data,
    width,
    height,
    offsetDots
) {
    if (offsetDots === 0) {
        return data;
    }

    const shifted = Buffer.alloc(
        width * height,
        WHITE
    );

    for (let y = 0; y < height; y += 1) {
        const rowOffset = y * width;

        for (let x = 0; x < width; x += 1) {
            const destinationX = x + offsetDots;

            if (
                destinationX < 0 ||
                destinationX >= width
            ) {
                continue;
            }

            shifted[rowOffset + destinationX] =
                data[rowOffset + x];
        }
    }

    return shifted;
}


/* -------------------------------------------------------------------------- */
/* Independent Y-axis shifting                                                */
/* -------------------------------------------------------------------------- */

/*
 * Shift image content vertically within the label raster.
 *
 * Positive offsetDots moves down.
 * Negative offsetDots moves up.
 *
 * Areas without image content are filled white.
 * Pixels shifted beyond the raster are clipped.
 */

function shiftGrayscaleVertically(
    data,
    width,
    height,
    offsetDots
) {
    if (offsetDots === 0) {
        return data;
    }

    const shifted = Buffer.alloc(
        width * height,
        WHITE
    );

    for (let y = 0; y < height; y += 1) {
        const destinationY = y + offsetDots;

        if (
            destinationY < 0 ||
            destinationY >= height
        ) {
            continue;
        }

        const sourceStart = y * width;
        const destinationStart = destinationY * width;

        data.copy(
            shifted,
            destinationStart,
            sourceStart,
            sourceStart + width
        );
    }

    return shifted;
}


/* -------------------------------------------------------------------------- */
/* Monochrome conversion                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Floyd-Steinberg error diffusion.
 *
 * Useful for logos, illustrations, and grayscale artwork printed on
 * monochrome thermal printers.
 */

function floydSteinbergDither(
    grayscale,
    width,
    height
) {
    const pixels = new Float32Array(
        width * height
    );

    const output = Buffer.alloc(
        width * height,
        WHITE
    );

    for (let i = 0; i < pixels.length; i += 1) {
        pixels[i] = grayscale[i];
    }

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;

            const oldPixel = Math.max(
                0,
                Math.min(255, pixels[index])
            );

            const newPixel =
                oldPixel < 128 ? BLACK : WHITE;

            const error = oldPixel - newPixel;

            output[index] = newPixel;

            if (x + 1 < width) {
                pixels[index + 1] +=
                    error * 7 / 16;
            }

            if (y + 1 < height) {
                if (x > 0) {
                    pixels[index + width - 1] +=
                        error * 3 / 16;
                }

                pixels[index + width] +=
                    error * 5 / 16;

                if (x + 1 < width) {
                    pixels[index + width + 1] +=
                        error / 16;
                }
            }
        }
    }

    return output;
}


/*
 * Simple threshold conversion.
 *
 * This can produce sharper results for black text and simple logos.
 */

function thresholdToMonochrome(
    grayscale,
    threshold
) {
    const output = Buffer.alloc(
        grayscale.length,
        WHITE
    );

    for (let i = 0; i < grayscale.length; i += 1) {
        output[i] =
            grayscale[i] < threshold
                ? BLACK
                : WHITE;
    }

    return output;
}


/* -------------------------------------------------------------------------- */
/* TSPL bitmap encoding                                                       */
/* -------------------------------------------------------------------------- */

/*
 * Convert a monochrome raster into a TSPL BITMAP payload.
 *
 * Confirmed polarity for this printer:
 *   0 bit = black / printed
 *   1 bit = white / unprinted
 *
 * TSPL bitmap width is measured in bytes, with 8 pixels per byte.
 */

function rasterToHolyhahBitmap(
    monochrome,
    width,
    height
) {
    const widthBytes = Math.ceil(width / 8);
    const physicalWidth = widthBytes * 8;

    const bitmap = Buffer.alloc(
        widthBytes * height,
        0xff
    );

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const pixelIndex = y * width + x;

            if (monochrome[pixelIndex] < 128) {
                const byteIndex =
                    y * widthBytes + Math.floor(x / 8);

                const bit =
                    0x80 >> (x % 8);

                bitmap[byteIndex] &= ~bit;
            }
        }
    }

    return {
        bitmap,
        widthBytes,
        physicalWidth,
    };
}


/* -------------------------------------------------------------------------- */
/* PNG loading and label raster creation                                      */
/* -------------------------------------------------------------------------- */

async function createLabelRaster(
    imagePath,
    options
) {
    const absoluteImagePath = path.resolve(
        imagePath
    );

    await fs.access(absoluteImagePath);

    const sourceMetadata = await sharp(
        absoluteImagePath
    ).metadata();

    if (sourceMetadata.format !== 'png') {
        throw new Error(
            `Input must be a PNG file. Detected: ${
                sourceMetadata.format || 'unknown'
            }.`
        );
    }

    if (
        !sourceMetadata.width ||
        !sourceMetadata.height
    ) {
        throw new Error(
            'The source PNG has invalid dimensions.'
        );
    }

    const paperWidthDots = mmToDots(
        options.widthMm
    );

    /*
     * TSPL bitmap width is expressed in whole bytes.
     *
     * For 51 mm at 203 DPI:
     *   51 mm = approximately 408 dots
     *   408 dots / 8 = 51 bytes
     */

    const width =
        Math.floor(paperWidthDots / 8) * 8;

    const height = mmToDots(
        options.heightMm
    );

    /*
     * Center the bitmap's byte-aligned width inside the
     * configured paper width.
     */

    const bitmapX = Math.floor(
        (paperWidthDots - width) / 2
    );

    if (width < 8 || height < 1) {
        throw new Error(
            'Calculated print dimensions are too small.'
        );
    }

    /*
     * Flatten transparency onto white before resizing.
     *
     * contain = preserve full image, with white padding.
     * cover   = fill target, cropping excess.
     * fill    = stretch to exact target dimensions.
     */

    const resized = await sharp(
        absoluteImagePath
    )
        .flatten({
            background: {
                r: 255,
                g: 255,
                b: 255,
            },
        })
        .resize({
            width,
            height,
            fit: options.fit,
            position: 'centre',
            background: {
                r: 255,
                g: 255,
                b: 255,
            },
            kernel: sharp.kernel.lanczos3,
        })
        .grayscale()
        .raw()
        .toBuffer({
            resolveWithObject: true,
        });

    if (resized.info.channels !== 1) {
        throw new Error(
            'Expected grayscale output with one channel; ' +
            `received ${resized.info.channels}.`
        );
    }

    /*
     * Apply X and Y alignment independently.
     *
     * Both operations work on the grayscale raster before
     * dithering and bitmap encoding.
     */

    const shiftedX = shiftGrayscaleHorizontally(
        resized.data,
        width,
        height,
        options.offsetDots
    );

    const shiftedXY = shiftGrayscaleVertically(
        shiftedX,
        width,
        height,
        options.offsetYDots
    );

    const monochrome = options.dither
        ? floydSteinbergDither(
            shiftedXY,
            width,
            height
        )
        : thresholdToMonochrome(
            shiftedXY,
            options.threshold
        );

    return {
        absoluteImagePath,

        sourceWidth: sourceMetadata.width,
        sourceHeight: sourceMetadata.height,

        width,
        height,

        paperWidthDots,
        bitmapX,

        monochrome,
    };
}


/* -------------------------------------------------------------------------- */
/* TSPL command creation                                                      */
/* -------------------------------------------------------------------------- */

function buildTsplPayload(
    raster,
    options
) {
    const converted = rasterToHolyhahBitmap(
        raster.monochrome,
        raster.width,
        raster.height
    );

    const prefix = Buffer.from(
        [
            `SIZE ${options.widthMm} mm,${options.heightMm} mm`,
            `GAP ${options.gapMm} mm,0 mm`,
            `SPEED ${CONFIG.speed}`,
            `DENSITY ${CONFIG.density}`,
            'DIRECTION 0,0',
            'REFERENCE 0,0',
            'CLS',
            '',
        ].join('\r\n'),
        'ascii'
    );

    /*
     * BITMAP syntax:
     *
     * BITMAP x,y,widthBytes,height,mode,<binary data>
     *
     * X is the printer coordinate. Y is zero because the
     * vertical offset has already been applied to the raster.
     */

    const bitmapHeader = Buffer.from(
        `BITMAP ${raster.bitmapX},0,` +
        `${converted.widthBytes},${raster.height},0,`,
        'ascii'
    );

    const bitmapCommand = Buffer.concat([
        bitmapHeader,
        converted.bitmap,
        Buffer.from('\r\n', 'ascii'),
    ]);

    const printCommand = Buffer.from(
        `PRINT 1,${options.copies}\r\n`,
        'ascii'
    );

    return {
        payload: Buffer.concat([
            prefix,
            bitmapCommand,
            printCommand,
        ]),

        physicalBitmapWidth: converted.physicalWidth,
        widthBytes: converted.widthBytes,
    };
}


/* -------------------------------------------------------------------------- */
/* Preview generation                                                         */
/* -------------------------------------------------------------------------- */

async function savePreview(
    previewPath,
    raster
) {
    const absolutePreviewPath = path.resolve(
        previewPath
    );

    if (
        absolutePreviewPath === raster.absoluteImagePath
    ) {
        throw new Error(
            'Preview path must not overwrite the source PNG.'
        );
    }

    await sharp(
        raster.monochrome,
        {
            raw: {
                width: raster.width,
                height: raster.height,
                channels: 1,
            },
        }
    )
        .png()
        .toFile(absolutePreviewPath);

    return absolutePreviewPath;
}


/* -------------------------------------------------------------------------- */
/* Print operation                                                            */
/* -------------------------------------------------------------------------- */

async function printImage(options) {
    validateOptions(options);

    const raster = await createLabelRaster(
        options.image,
        options
    );

    let previewPath = null;

    if (options.preview) {
        previewPath = await savePreview(
            options.preview,
            raster
        );
    }

    if (options.previewOnly) {
        console.log(
            '[holyhah-image] Preview-only mode. ' +
            'No data was sent to the printer.'
        );

        return {
            previewPath,

            source: {
                path: raster.absoluteImagePath,
                width: raster.sourceWidth,
                height: raster.sourceHeight,
            },

            label: {
                widthMm: options.widthMm,
                heightMm: options.heightMm,
                dpi: CONFIG.dpi,
                widthDots: raster.width,
                heightDots: raster.height,
                fit: options.fit,
                dither: options.dither,
                offsetDots: options.offsetDots,
                offsetYDots: options.offsetYDots,
            },

            printed: false,
        };
    }

    const {
        payload,
        physicalBitmapWidth,
        widthBytes,
    } = buildTsplPayload(
        raster,
        options
    );

    console.log(
        '[holyhah-image] Source:',
        raster.absoluteImagePath
    );

    console.log(
        `[holyhah-image] Source dimensions: ` +
        `${raster.sourceWidth} x ${raster.sourceHeight} px`
    );

    console.log(
        `[holyhah-image] Label: ${options.widthMm} x ` +
        `${options.heightMm} mm at ${CONFIG.dpi} DPI`
    );

    console.log(
        `[holyhah-image] Raster: ${raster.width} x ` +
        `${raster.height} dots`
    );

    console.log(
        `[holyhah-image] X offset: ${options.offsetDots} dots`
    );

    console.log(
        `[holyhah-image] Y offset: ${options.offsetYDots} dots`
    );

    console.log(
        `[holyhah-image] Bitmap width: ${widthBytes} bytes ` +
        `(${physicalBitmapWidth} dots)`
    );

    console.log(
        `[holyhah-image] Fit: ${options.fit}`
    );

    console.log(
        `[holyhah-image] Dithering: ` +
        `${options.dither ? 'enabled' : 'disabled'}`
    );

    if (previewPath) {
        console.log(
            '[holyhah-image] Preview saved:',
            previewPath
        );
    }

    console.log(
        `[holyhah-image] Sending ${options.copies} ` +
        `copy/copies to ${CONFIG.device}...`
    );

    /*
     * Uses the existing transport helper.
     * It should validate and write to the device without
     * creating a regular file if the USB printer is absent.
     */

    await writePrinter(
        CONFIG.device,
        payload
    );

    console.log(
        '[holyhah-image] Print job sent successfully.'
    );

    return {
        source: {
            path: raster.absoluteImagePath,
            width: raster.sourceWidth,
            height: raster.sourceHeight,
        },

        label: {
            widthMm: options.widthMm,
            heightMm: options.heightMm,
            gapMm: options.gapMm,
            dpi: CONFIG.dpi,

            widthDots: raster.width,
            heightDots: raster.height,

            bitmapX: raster.bitmapX,

            copies: options.copies,
            fit: options.fit,
            dither: options.dither,

            offsetDots: options.offsetDots,
            offsetYDots: options.offsetYDots,

            previewPath,
        },

        printed: true,
    };
}


/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function main() {
    const options = parseArguments(
        process.argv.slice(2)
    );

    if (options.help) {
        printHelp();
        return;
    }

    const result = await printImage(options);

    console.log(
        JSON.stringify(result, null, 2)
    );
}


if (require.main === module) {
    main().catch(error => {
        console.error(
            '[holyhah-image] Printing failed:',
            error.message
        );

        process.exitCode = 1;
    });
}


/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
    CONFIG,

    parseArguments,
    mmToDots,

    shiftGrayscaleHorizontally,
    shiftGrayscaleVertically,

    floydSteinbergDither,
    thresholdToMonochrome,

    rasterToHolyhahBitmap,
    createLabelRaster,
    buildTsplPayload,

    printImage,
};
