let records = [];

const eventName = (event) =>
  event.event.type === 'spanOpen' ? event.event.name : null;

const parentSpanId = (event) => event.spanContext.spanId ?? null;

const eventSpanId = (event) =>
  'spanId' in event.event ? event.event.spanId : parentSpanId(event);

const projectEvent = (event) => ({
  invocationId: event.invocationId,
  name: eventName(event),
  parentSpanId: parentSpanId(event),
  sequence: event.sequence,
  spanId: eventSpanId(event),
  traceId: event.spanContext.traceId,
  type: event.event.type,
});

export default {
  async fetch(request) {
    if (request.method === 'DELETE') {
      records = [];
      return new Response(null, { status: 204 });
    }

    return Response.json(records);
  },
  tailStream(onset) {
    records.push(projectEvent(onset));
    return (event) => {
      records.push(projectEvent(event));
    };
  },
};
