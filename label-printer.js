'use strict';

const TorreyScale =
    require('./torrey-scale');

const ScaleLabelIntegration =
    require('./scale-label-integration');

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');

const sharp = require('sharp');
const bwipjs = require('bwip-js');

const {
    writePrinter,
} = require('./usb-printer-transport');

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const CONFIG = Object.freeze({
    device:
        process.env.LABEL_PRINTER_DEVICE ||
        '/dev/holyhah-label',

    widthMm:
        Number(
            process.env.LABEL_WIDTH_MM ||
            51
        ),

    heightMm:
        Number(
            process.env.LABEL_HEIGHT_MM ||
            30
        ),

    gapMm:
        Number(
            process.env.LABEL_GAP_MM ||
            2
        ),

    dpi:
        Number(
            process.env.LABEL_DPI ||
            203
        ),

    speed:
        Number(
            process.env.LABEL_SPEED ||
            5
        ),

    density:
        Number(
            process.env.LABEL_DENSITY ||
            7
        ),

    horizontalOffsetDots:
        Number(
            process.env.LABEL_HORIZONTAL_OFFSET_DOTS ||
            0
        ),

    logoPath:
        process.env.LABEL_LOGO_PATH
            ? path.resolve(
                process.env.LABEL_LOGO_PATH
            )
            : null,

    logoThreshold:
        Number(
            process.env.LABEL_LOGO_THRESHOLD ||
            180
        ),
});

/*
|--------------------------------------------------------------------------
| Measurement helpers
|--------------------------------------------------------------------------
*/

function dotsPerMm(
    dpi = CONFIG.dpi
) {
    return dpi / 25.4;
}

function mmToDots(
    mm,
    dpi = CONFIG.dpi
) {
    return Math.round(
        Number(mm) *
        dotsPerMm(dpi)
    );
}

function createCanvas({
    widthMm,
    heightMm,
    dpi = CONFIG.dpi,
}) {
    return {
        widthMm,
        heightMm,
        dpi,

        width:
            mmToDots(
                widthMm,
                dpi
            ),

        height:
            mmToDots(
                heightMm,
                dpi
            ),
    };
}

/*
|--------------------------------------------------------------------------
| Validation
|--------------------------------------------------------------------------
*/

function positiveNumber(
    value,
    name
) {
    const numeric =
        Number(value);

    if (
        !Number.isFinite(numeric) ||
        numeric <= 0
    ) {
        throw new TypeError(
            `${name} must be a positive number`
        );
    }

    return numeric;
}

function validateLabelData(
    data
) {
    if (
        !data ||
        typeof data !== 'object'
    ) {
        throw new TypeError(
            'Label data must be an object'
        );
    }

    if (
        typeof data.productName !==
            'string' ||
        !data.productName.trim()
    ) {
        throw new TypeError(
            'productName is required'
        );
    }

    if (
        data.quantity === undefined ||
        data.quantity === null ||
        !String(
            data.quantity
        ).trim()
    ) {
        throw new TypeError(
            'quantity is required'
        );
    }

    if (
        typeof data.barcode !==
            'string' ||
        !data.barcode.trim()
    ) {
        throw new TypeError(
            'barcode is required'
        );
    }

    if (
        data.copies !== undefined
    ) {
        const copies =
            Number(data.copies);

        if (
            !Number.isInteger(copies) ||
            copies < 1 ||
            copies > 100
        ) {
            throw new TypeError(
                'copies must be an integer between 1 and 100'
            );
        }
    }
}

/*
|--------------------------------------------------------------------------
| Text helpers
|--------------------------------------------------------------------------
*/

function cleanText(
    value
) {
    return String(
        value ?? ''
    )
        .replace(
            /[\r\n\t]+/g,
            ' '
        )
        .replace(
            /\s+/g,
            ' '
        )
        .trim();
}

function escapeXml(
    value
) {
    return cleanText(value)
        .replace(
            /&/g,
            '&amp;'
        )
        .replace(
            /</g,
            '&lt;'
        )
        .replace(
            />/g,
            '&gt;'
        )
        .replace(
            /"/g,
            '&quot;'
        )
        .replace(
            /'/g,
            '&apos;'
        );
}

/*
|--------------------------------------------------------------------------
| SVG text measurement
|--------------------------------------------------------------------------
|
| We use a conservative approximation only to decide whether text should
| shrink or wrap.
|
| Actual centering is performed by SVG using:
|
|     x="50%"
|     text-anchor="middle"
|
| Therefore the final horizontal position is pixel-accurate.
|
*/

function approximateTextWidth(
    text,
    fontSize
) {
    return (
        cleanText(text).length *
        fontSize *
        0.58
    );
}

function fitFontSize(
    text,
    maxWidth,
    {
        preferredSize,
        minimumSize,
    }
) {
    let size =
        preferredSize;

    while (
        size > minimumSize &&
        approximateTextWidth(
            text,
            size
        ) > maxWidth
    ) {
        size -= 1;
    }

    return size;
}

function wrapText(
    text,
    maxWidth,
    fontSize,
    maxLines = 2
) {
    const words =
        cleanText(text)
            .split(' ')
            .filter(Boolean);

    if (
        words.length === 0
    ) {
        return [];
    }

    const lines = [];
    let current = '';

    for (
        const word of words
    ) {
        const candidate =
            current
                ? `${current} ${word}`
                : word;

        if (
            approximateTextWidth(
                candidate,
                fontSize
            ) <= maxWidth
        ) {
            current =
                candidate;

            continue;
        }

        if (current) {
            lines.push(
                current
            );

            if (
                lines.length >=
                maxLines
            ) {
                return lines;
            }
        }

        /*
         * Handle extremely long words.
         */
        if (
            approximateTextWidth(
                word,
                fontSize
            ) > maxWidth
        ) {
            let fragment = '';

            for (
                const character
                of word
            ) {
                const fragmentCandidate =
                    fragment +
                    character;

                if (
                    approximateTextWidth(
                        fragmentCandidate,
                        fontSize
                    ) <= maxWidth
                ) {
                    fragment =
                        fragmentCandidate;

                    continue;
                }

                if (fragment) {
                    lines.push(
                        fragment
                    );

                    if (
                        lines.length >=
                        maxLines
                    ) {
                        return lines;
                    }
                }

                fragment =
                    character;
            }

            current =
                fragment;

            continue;
        }

        current =
            word;
    }

    if (
        current &&
        lines.length <
            maxLines
    ) {
        lines.push(
            current
        );
    }

    return lines;
}

/*
|--------------------------------------------------------------------------
| SVG generation
|--------------------------------------------------------------------------
*/

function buildCenteredTextSvg({
    width,
    height,
    lines,

    fontSize,
    fontWeight = 500,

    lineHeight = 1.15,

    horizontalOffset = 0,

    fontFamily =
        'DejaVu Sans, sans-serif',
}) {
    const safeLines =
        lines.map(
            escapeXml
        );

    const lineSpacing =
        fontSize *
        lineHeight;

    const totalTextHeight =
        safeLines.length *
        lineSpacing;

    const firstBaseline =
        (
            height -
            totalTextHeight
        ) / 2 +
        fontSize;

    /*
     * Physical center of the label plus
     * our printer calibration correction.
     */
    const centerX =
        width / 2 +
        horizontalOffset;

    const textElements =
        safeLines
            .map(
                (
                    line,
                    index
                ) => {
                    const y =
                        firstBaseline +
                        (
                            index *
                            lineSpacing
                        );

                    return `
                        <text
                            x="${centerX}"
                            y="${y}"
                            text-anchor="middle"
                            font-family="${fontFamily}"
                            font-size="${fontSize}"
                            font-weight="${fontWeight}"
                            fill="#000000"
                        >${line}</text>
                    `;
                }
            )
            .join('\n');

    return Buffer.from(
        `
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="${width}"
            height="${height}"
            viewBox="0 0 ${width} ${height}"
        >
            <rect
                width="100%"
                height="100%"
                fill="#ffffff"
            />

            ${textElements}
        </svg>
        `
    );
}

/*
|--------------------------------------------------------------------------
| Logo generation
|--------------------------------------------------------------------------
*/

async function buildLogoImage(
    logoPath,
    {
        maxWidth,
        maxHeight,
        threshold =
            CONFIG.logoThreshold,
    }
) {
    if (!logoPath) {
        return null;
    }

    await fs.access(
        logoPath
    );

    const buffer =
        await sharp(
            logoPath
        )
            /*
             * Remove alpha ambiguity.
             */
            .flatten({
                background:
                    '#ffffff',
            })

            .resize({
                width:
                    Math.max(
                        1,
                        Math.round(
                            maxWidth
                        )
                    ),

                height:
                    Math.max(
                        1,
                        Math.round(
                            maxHeight
                        )
                    ),

                fit:
                    'inside',

                withoutEnlargement:
                    true,
            })

            .grayscale()

            .threshold(
                threshold
            )

            .png()

            .toBuffer();

    const metadata =
        await sharp(
            buffer
        ).metadata();

    return {
        buffer,

        width:
            metadata.width,

        height:
            metadata.height,
    };
}

/*
|--------------------------------------------------------------------------
| Barcode generation
|--------------------------------------------------------------------------
*/

async function buildBarcodeImage(
    barcode,
    {
        maxWidth,
        maxHeight,
    }
) {
    const value =
        cleanText(
            barcode
        );

    /*
     * Generate a Code 128 barcode independently from TSPL.
     *
     * This avoids firmware-specific barcode positioning behavior.
     */
    const original =
        await bwipjs.toBuffer({
            bcid:
                'code128',

            text:
                value,

            scale:
                3,

            height:
                10,

            includetext:
                true,

            textxalign:
                'center',

            textsize:
                10,

            paddingwidth:
                0,

            paddingheight:
                0,

            backgroundcolor:
                'FFFFFF',

            barcolor:
                '000000',

            textcolor:
                '000000',
        });

    const resized =
        await sharp(
            original
        )
            .resize({
                width:
                    Math.round(
                        maxWidth
                    ),

                height:
                    Math.round(
                        maxHeight
                    ),

                fit:
                    'inside',

                withoutEnlargement:
                    false,
            })

            .flatten({
                background:
                    '#ffffff',
            })

            .grayscale()

            .threshold(
                170
            )

            .png()

            .toBuffer();

    const metadata =
        await sharp(
            resized
        ).metadata();

    return {
        buffer:
            resized,

        width:
            metadata.width,

        height:
            metadata.height,
    };
}

/*
|--------------------------------------------------------------------------
| Composite complete label
|--------------------------------------------------------------------------
*/

async function renderLabel({
    logoPath,
    storeName,
    productName,
    quantity,
    barcode,
    canvas,
}) {
    const {
        width,
        height,
    } = canvas;

    const horizontalOffset =
        CONFIG.horizontalOffsetDots;

    /*
    |--------------------------------------------------------------------------
    | Safe margins
    |--------------------------------------------------------------------------
    */

    const horizontalMargin =
        Math.max(
            10,
            Math.round(
                width * 0.035
            )
        );

    const topMargin =
        Math.max(
            3,
            Math.round(
                height * 0.015
            )
        );

    const bottomMargin =
        Math.max(
            5,
            Math.round(
                height * 0.025
            )
        );

    const usableWidth =
        width -
        horizontalMargin * 2;

    /*
    |--------------------------------------------------------------------------
    | Vertical regions
    |--------------------------------------------------------------------------
    */

    const logoAreaHeight =
        Math.round(
            height * 0.25
        );

    const storeAreaHeight =
        Math.round(
            height * 0.15
        );

    const productAreaHeight =
        Math.round(
            height * 0.18
        );

    const barcodeAreaHeight =
        Math.max(
            40,
            height -
                topMargin -
                bottomMargin -
                logoAreaHeight -
                storeAreaHeight -
                productAreaHeight
        );

    const composites = [];

    let currentY =
        topMargin;

    /*
    |--------------------------------------------------------------------------
    | Logo
    |--------------------------------------------------------------------------
    */

    let logoLayout = null;

    if (logoPath) {
        const logo =
            await buildLogoImage(
                logoPath,
                {
                    maxWidth:
                        usableWidth * 0.28,

                    maxHeight:
                        logoAreaHeight * 0.98,

                    threshold:
                        CONFIG.logoThreshold,
                }
            );

        if (logo) {
            const left =
                Math.max(
                    0,
                    Math.min(
                        width - logo.width,
                        Math.round(
                            (
                                width -
                                logo.width
                            ) / 2 +
                            horizontalOffset
                        )
                    )
                );

            const top =
                currentY +
                Math.max(
                    0,
                    Math.round(
                        (
                            logoAreaHeight -
                            logo.height
                        ) / 2
                    )
                );

            composites.push({
                input:
                    logo.buffer,

                left,
                top,
            });

            logoLayout = {
                left,
                top,

                width:
                    logo.width,

                height:
                    logo.height,
            };
        }
    }

    currentY +=
        logoAreaHeight;

    /*
    |--------------------------------------------------------------------------
    | Store name
    |--------------------------------------------------------------------------
    */

    const cleanedStoreName =
        cleanText(
            storeName
        );

    const storeFontSize =
        fitFontSize(
            cleanedStoreName,
            usableWidth,
            {
                preferredSize:
                    Math.round(
                        height * 0.09
                    ),

                minimumSize:
                    12,
            }
        );

    const storeSvg =
        buildCenteredTextSvg({
            width,

            height:
                storeAreaHeight,

            lines: [
                cleanedStoreName,
            ],

            fontSize:
                storeFontSize,

            fontWeight:
                600,

            horizontalOffset,
        });

    composites.push({
        input:
            storeSvg,

        left:
            0,

        top:
            currentY,
    });

    const storeLayout = {
        top:
            currentY,

        height:
            storeAreaHeight,

        fontSize:
            storeFontSize,
    };

    currentY +=
        storeAreaHeight;

    /*
    |--------------------------------------------------------------------------
    | Product + quantity
    |--------------------------------------------------------------------------
    */

    const cleanedProduct =
        cleanText(
            productName
        );

    const cleanedQuantity =
        cleanText(
            quantity
        );

    const combinedText =
        cleanedQuantity
            ? `${cleanedProduct} ${cleanedQuantity}`
            : cleanedProduct;

    let productFontSize =
        fitFontSize(
            combinedText,
            usableWidth,
            {
                preferredSize:
                    Math.round(
                        height * 0.09
                    ),

                minimumSize:
                    12,
            }
        );

    let productLines =
        wrapText(
            combinedText,
            usableWidth,
            productFontSize,
            2
        );

    if (
        productLines.length > 1
    ) {
        productFontSize =
            Math.max(
                12,
                Math.min(
                    productFontSize,
                    Math.floor(
                        productAreaHeight /
                        2.4
                    )
                )
            );

        productLines =
            wrapText(
                combinedText,
                usableWidth,
                productFontSize,
                2
            );
    }

    const productSvg =
        buildCenteredTextSvg({
            width,

            height:
                productAreaHeight,

            lines:
                productLines,

            fontSize:
                productFontSize,

            fontWeight:
                500,

            lineHeight:
                1.05,

            horizontalOffset,
        });

    composites.push({
        input:
            productSvg,

        left:
            0,

        top:
            currentY,
    });

    const productLayout = {
        top:
            currentY,

        height:
            productAreaHeight,

        lines:
            productLines,

        fontSize:
            productFontSize,
    };

    currentY +=
        productAreaHeight;

    /*
    |--------------------------------------------------------------------------
    | Barcode
    |--------------------------------------------------------------------------
    */

    const barcodeMaxWidth =
        usableWidth * 0.82;

    const barcodeMaxHeight =
        barcodeAreaHeight * 0.90;

    const barcodeImage =
        await buildBarcodeImage(
            barcode,
            {
                maxWidth:
                    barcodeMaxWidth,

                maxHeight:
                    barcodeMaxHeight,
            }
        );

    const barcodeLeft =
        Math.max(
            0,
            Math.min(
                width -
                    barcodeImage.width,

                Math.round(
                    (
                        width -
                        barcodeImage.width
                    ) / 2 +
                    horizontalOffset
                )
            )
        );

    const barcodeTop =
        currentY +
        Math.max(
            0,
            Math.round(
                (
                    barcodeAreaHeight -
                    barcodeImage.height
                ) / 2
            )
        );

    composites.push({
        input:
            barcodeImage.buffer,

        left:
            barcodeLeft,

        top:
            barcodeTop,
    });

    const barcodeLayout = {
        left:
            barcodeLeft,

        top:
            barcodeTop,

        width:
            barcodeImage.width,

        height:
            barcodeImage.height,
    };

    /*
    |--------------------------------------------------------------------------
    | Composite complete label
    |--------------------------------------------------------------------------
    */

    const rendered =
        await sharp({
            create: {
                width,
                height,

                /*
                 * Sharp create input must use
                 * RGB or RGBA.
                 */
                channels: 3,

                background: {
                    r: 255,
                    g: 255,
                    b: 255,
                },
            },
        })

            .composite(
                composites
            )

            /*
             * Convert final RGB canvas
             * into monochrome.
             */
            .grayscale()

            .threshold(
                180
            )

            /*
             * Return raw pixels for TSPL
             * bitmap conversion.
             */
            .raw()

            .toBuffer({
                resolveWithObject:
                    true,
            });

    return {
        data:
            rendered.data,

        info:
            rendered.info,

        layout: {
            width,
            height,

            horizontalMargin,
            horizontalOffset,
            topMargin,
            bottomMargin,

            logo:
                logoLayout,

            store:
                storeLayout,

            product:
                productLayout,

            barcode:
                barcodeLayout,
        },
    };
}

/*
|--------------------------------------------------------------------------
| HOLYHAH bitmap conversion
|--------------------------------------------------------------------------
|
| Hardware testing established the polarity:
|
|     0 = printed black
|     1 = white
|
| So every byte starts at 0xFF and black pixels clear individual bits.
|
*/

function rasterToHolyhahBitmap(
    data,
    width,
    height,
    channels = 1
) {
    const widthBytes =
        Math.ceil(
            width / 8
        );

    const physicalWidth =
        widthBytes * 8;

    /*
     * Start completely white.
     */
    const bitmap =
        Buffer.alloc(
            widthBytes *
            height,

            0xff
        );

    for (
        let y = 0;

        y < height;

        y += 1
    ) {
        for (
            let x = 0;

            x < width;

            x += 1
        ) {
            const sourceIndex =
                (
                    y *
                    width +
                    x
                ) *
                channels;

            const pixel =
                data[
                    sourceIndex
                ];

            /*
             * Black pixel.
             */
            if (
                pixel < 128
            ) {
                const byteIndex =
                    y *
                    widthBytes +
                    Math.floor(
                        x / 8
                    );

                const bit =
                    0x80 >>
                    (
                        x %
                        8
                    );

                bitmap[
                    byteIndex
                ] &= ~bit;
            }
        }
    }

    return {
        bitmap,

        widthBytes,

        physicalWidth,
    };
}

/*
|--------------------------------------------------------------------------
| TSPL payload
|--------------------------------------------------------------------------
*/

function buildTsplBitmapCommand({
    bitmap,
    widthBytes,
    height,
}) {
    /*
     * Entire label begins at 0,0.
     *
     * Since the label itself was rendered at its real paper size,
     * everything inside it is already centered.
     */
    const header =
        Buffer.from(
            (
                `BITMAP ` +
                `0,0,` +
                `${widthBytes},` +
                `${height},` +
                `0,`
            ),

            'ascii'
        );

    return Buffer.concat([
        header,

        bitmap,

        Buffer.from(
            '\r\n',
            'ascii'
        ),
    ]);
}

/*
|--------------------------------------------------------------------------
| Build label
|--------------------------------------------------------------------------
*/

async function buildProductLabel({
    productName,

    quantity,

    barcode,

    storeName =
        'Abarrotes Todo En Uno',

    logoPath =
        CONFIG.logoPath,

    copies =
        1,

    paper = {},
}) {
    validateLabelData({
        productName,
        quantity,
        barcode,
        copies,
    });

    /*
    |--------------------------------------------------------------------------
    | Dynamic paper dimensions
    |--------------------------------------------------------------------------
    */

    const widthMm =
        positiveNumber(
            paper.widthMm ??
                CONFIG.widthMm,

            'paper.widthMm'
        );

    const heightMm =
        positiveNumber(
            paper.heightMm ??
                CONFIG.heightMm,

            'paper.heightMm'
        );

    const gapMm =
        positiveNumber(
            paper.gapMm ??
                CONFIG.gapMm,

            'paper.gapMm'
        );

    const canvas =
        createCanvas({
            widthMm,
            heightMm,

            dpi:
                CONFIG.dpi,
        });

    /*
    |--------------------------------------------------------------------------
    | Render complete label
    |--------------------------------------------------------------------------
    */

    const rendered =
        await renderLabel({
            logoPath,

            storeName,

            productName,

            quantity,

            barcode,

            canvas,
        });

    /*
    |--------------------------------------------------------------------------
    | Convert to printer bitmap
    |--------------------------------------------------------------------------
    */

    const bitmap =
        rasterToHolyhahBitmap(
            rendered.data,

            rendered.info.width,

            rendered.info.height,

            rendered.info.channels
        );

    /*
    |--------------------------------------------------------------------------
    | Printer configuration
    |--------------------------------------------------------------------------
    */

    const prefix =
        Buffer.from(
            [
                `SIZE ${widthMm} mm,${heightMm} mm`,

                `GAP ${gapMm} mm,0 mm`,

                `SPEED ${CONFIG.speed}`,

                `DENSITY ${CONFIG.density}`,

                'DIRECTION 0,0',

                'REFERENCE 0,0',

                'CLS',

                '',
            ].join(
                '\r\n'
            ),

            'ascii'
        );

    /*
    |--------------------------------------------------------------------------
    | Bitmap command
    |--------------------------------------------------------------------------
    */

    const bitmapCommand =
        buildTsplBitmapCommand({
            bitmap:
                bitmap.bitmap,

            widthBytes:
                bitmap.widthBytes,

            height:
                rendered.info.height,
        });

    /*
    |--------------------------------------------------------------------------
    | Number of copies
    |--------------------------------------------------------------------------
    */

    const copyCount =
        Math.max(
            1,

            Math.min(
                100,

                Math.floor(
                    Number(
                        copies
                    ) || 1
                )
            )
        );

    const printCommand =
        Buffer.from(
            (
                `PRINT 1,` +
                `${copyCount}` +
                '\r\n'
            ),

            'ascii'
        );

    /*
    |--------------------------------------------------------------------------
    | Complete printer payload
    |--------------------------------------------------------------------------
    */

    return {
        buffer:
            Buffer.concat([
                prefix,

                bitmapCommand,

                printCommand,
            ]),

        layout: {
            paper: {
                widthMm,
                heightMm,
                gapMm,

                dpi:
                    CONFIG.dpi,

                widthDots:
                    canvas.width,

                heightDots:
                    canvas.height,

                physicalBitmapWidth:
                    bitmap
                        .physicalWidth,
            },

            ...rendered.layout,

            copies:
                copyCount,
        },
    };
}

/*
|--------------------------------------------------------------------------
| Public print method
|--------------------------------------------------------------------------
*/

async function printProductLabel(
    labelData
) {
    const {
        buffer,
        layout,
    } =
        await buildProductLabel(
            labelData
        );

    const result =
        await writePrinter(
            CONFIG.device,
            buffer
        );

    return {
        ...result,

        layout,
    };
}

const scale =
    new TorreyScale({
        device:
            process.env.SCALE_DEVICE ||
            '/dev/torrey-scale',

        baudRate:
            Number(
                process.env.SCALE_BAUDRATE ||
                9600
            ),

        dataBits:
            Number(
                process.env.SCALE_DATA_BITS ||
                8
            ),

        stopBits:
            Number(
                process.env.SCALE_STOP_BITS ||
                1
            ),

        parity:
            process.env.SCALE_PARITY ||
            'none',
    });

    
const scaleIntegration =
    new ScaleLabelIntegration({
        scale,

        printLabel:
            async ({
                productName,
                barcode,
                quantity,
                unit,
            }) => {

                await printProductLabel({
                    productName,

                    barcode,

                    quantity,

                    unit,
                });
            },
    });

/*
|--------------------------------------------------------------------------
| Preview
|--------------------------------------------------------------------------
|
| Useful during layout development.
|
| Creates a PNG representation of exactly what the printer should receive.
|
*/

async function generatePreview(
    labelData,
    outputPath
) {
    validateLabelData(
        labelData
    );

    const paper =
        labelData.paper || {};

    const widthMm =
        positiveNumber(
            paper.widthMm ??
                CONFIG.widthMm,

            'paper.widthMm'
        );

    const heightMm =
        positiveNumber(
            paper.heightMm ??
                CONFIG.heightMm,

            'paper.heightMm'
        );

    const canvas =
        createCanvas({
            widthMm,
            heightMm,

            dpi:
                CONFIG.dpi,
        });

    const rendered =
        await renderLabel({
            logoPath:
                labelData.logoPath ??
                CONFIG.logoPath,

            storeName:
                labelData.storeName ??
                'Abarrotes Todo En Uno',

            productName:
                labelData.productName,

            quantity:
                labelData.quantity,

            barcode:
                labelData.barcode,

            canvas,
        });

    await sharp(
        rendered.data,
        {
            raw: {
                width:
                    rendered.info
                        .width,

                height:
                    rendered.info
                        .height,

                channels:
                    rendered.info
                        .channels,
            },
        }
    )
        .png()
        .toFile(
            outputPath
        );

    return {
        outputPath,

        layout:
            rendered.layout,
    };
}

/*
|--------------------------------------------------------------------------
| Standalone test
|--------------------------------------------------------------------------
*/

async function main() {
    const label = {
        logoPath:
            CONFIG.logoPath,

        storeName:
            'Abarrotes Todo En Uno',

        productName:
            'Arroz Super Extra',

        quantity:
            '1 kg',

        barcode:
            '01234567',

        copies:
            1,

        paper: {
            widthMm:
                CONFIG.widthMm,

            heightMm:
                CONFIG.heightMm,

            gapMm:
                CONFIG.gapMm,
        },
    };

    /*
     * Uncomment this while tuning the design.
     *
     * This lets you inspect the final raster before wasting labels.
     */

    const preview =
        await generatePreview(
            label,
            path.join(
                __dirname,
                'label-preview.png'
            )
        );

    console.log(
        'Preview:',
        preview
    );

    const result =
        await printProductLabel(
            label
        );

    console.log(
        JSON.stringify(
            result,
            null,
            2
        )
    );
}

if (
    require.main ===
    module
) {
    main().catch(
        error => {
            console.error(
                'Label printing failed:',
                error
            );

            process.exitCode = 1;
        }
    );
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
    CONFIG,

    dotsPerMm,
    mmToDots,
    createCanvas,

    cleanText,
    escapeXml,

    approximateTextWidth,
    fitFontSize,
    wrapText,

    buildCenteredTextSvg,
    buildLogoImage,
    buildBarcodeImage,

    renderLabel,

    rasterToHolyhahBitmap,
    buildTsplBitmapCommand,

    buildProductLabel,
    printProductLabel,

    generatePreview,
};