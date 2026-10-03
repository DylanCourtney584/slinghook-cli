/**
 * Incremental parser for the text/event-stream format.
 *
 * Feed it decoded text chunks as they arrive; it calls onEvent for every
 * complete event. Comment lines (": heartbeat") are ignored.
 */
export function createSseParser(onEvent) {
    let buffer = '';
    let event = blankEvent();

    function blankEvent() {
        return { id: null, event: 'message', data: [] };
    }

    function dispatch() {
        if (event.data.length > 0) {
            onEvent({ id: event.id, event: event.event, data: event.data.join('\n') });
        }
        event = blankEvent();
    }

    function processLine(line) {
        if (line === '') {
            dispatch();
            return;
        }
        if (line.startsWith(':')) return;

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'data') event.data.push(value);
        else if (field === 'event') event.event = value;
        else if (field === 'id') event.id = value;
    }

    return {
        push(chunk) {
            buffer += chunk;
            let newline;
            while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
                // A trailing \r may be the first half of a \r\n split across chunks
                if (newline === buffer.length - 1 && buffer.endsWith('\r')) break;
                const line = buffer.slice(0, newline);
                const sepLength = buffer.startsWith('\r\n', newline) ? 2 : 1;
                buffer = buffer.slice(newline + sepLength);
                processLine(line);
            }
        }
    };
}
