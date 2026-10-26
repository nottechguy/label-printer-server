'use strict';

const fs = require('node:fs/promises');
const {
    constants,
} = require('node:fs');

class PrinterError extends Error {
    constructor(
        message,
        code = null,
        cause = null
    ) {
        super(
            message,
            {
                cause,
            }
        );

        this.name =
            'PrinterError';

        this.code =
            code;
    }
}

async function deviceExists(
    device
) {
    try {
        const stat =
            await fs.stat(
                device
            );

        return (
            stat
                .isCharacterDevice()
        );
    } catch {
        return false;
    }
}

async function checkDevice(
    device
) {
    let stat;

    try {
        stat =
            await fs.stat(
                device
            );
    } catch (error) {
        if (
            error.code ===
            'ENOENT'
        ) {
            throw new PrinterError(
                `Printer is disconnected: ${device}`,
                'PRINTER_DISCONNECTED',
                error
            );
        }

        throw error;
    }

    if (
        !stat
            .isCharacterDevice()
    ) {
        throw new PrinterError(
            `Printer path is not a character device: ${device}`,
            'INVALID_DEVICE'
        );
    }

    try {
        await fs.access(
            device,
            constants.W_OK
        );
    } catch (error) {
        throw new PrinterError(
            `Permission denied for printer: ${device}`,
            'PRINTER_PERMISSION_DENIED',
            error
        );
    }

    return true;
}

async function writePrinter(
    device,
    data
) {
    if (
        !Buffer.isBuffer(data)
    ) {
        throw new TypeError(
            'Printer payload must be a Buffer'
        );
    }

    await checkDevice(
        device
    );

    let handle =
        null;

    try {
        handle =
            await fs.open(
                device,

                constants.O_WRONLY |
                constants.O_CLOEXEC
            );

        let offset =
            0;

        while (
            offset <
            data.length
        ) {
            const {
                bytesWritten,
            } =
                await handle.write(
                    data,

                    offset,

                    data.length -
                    offset,

                    null
                );

            if (
                bytesWritten <=
                0
            ) {
                throw new PrinterError(
                    'Printer accepted zero bytes',
                    'ZERO_BYTE_WRITE'
                );
            }

            offset +=
                bytesWritten;
        }

        return {
            success:
                true,

            bytesWritten:
                data.length,
        };
    } catch (error) {
        switch (
            error.code
        ) {
            case 'ENOENT':

            case 'ENODEV':
                throw new PrinterError(
                    'Label printer is disconnected',
                    'PRINTER_DISCONNECTED',
                    error
                );

            case 'EACCES':

            case 'EPERM':
                throw new PrinterError(
                    'Permission denied accessing label printer',
                    'PRINTER_PERMISSION_DENIED',
                    error
                );

            case 'EBUSY':
                throw new PrinterError(
                    'Label printer is busy',
                    'PRINTER_BUSY',
                    error
                );

            case 'EIO':
                throw new PrinterError(
                    'USB I/O error while printing',
                    'PRINTER_IO_ERROR',
                    error
                );

            default:
                throw error;
        }
    } finally {
        if (
            handle !==
            null
        ) {
            await handle
                .close()
                .catch(
                    () => {}
                );
        }
    }
}

module.exports = {
    PrinterError,
    deviceExists,
    checkDevice,
    writePrinter,
};