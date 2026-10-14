import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityRepository } from './identity.js';

const metadata = { publisherId: 'publisher-a', name: 'Publisher A', currency: 'USD' };

function repository(item?: Record<string, unknown>) {
  const send = vi.fn().mockResolvedValueOnce({ Item: item }).mockResolvedValue({});
  vi.spyOn(DynamoDBDocumentClient, 'from').mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
  const client = new DynamoDBClient({ region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });

  return { repository: new IdentityRepository(client, 'bid-test'), send };
}

afterEach(() => vi.restoreAllMocks());

describe('publisher metadata', () => {
  it('creates metadata without provenance flags', async () => {
    const { repository: identity, send } = repository();
    await identity.ensureDemoPublisher('a');

    const command = send.mock.calls[1]?.[0];
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input.Item).toEqual({ PK: 'PUBLISHER#publisher-a', SK: 'METADATA', data: metadata });
  });

  it('removes legacy flags without replacing publisher data and guards concurrent changes', async () => {
    const stored = { ...metadata, demoData: true, synthetic: true };
    const { repository: identity, send } = repository({ data: stored });
    await identity.ensureDemoPublisher('a');

    const command = send.mock.calls[1]?.[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input).toMatchObject({
      UpdateExpression: 'REMOVE #data.#demo, #data.#synthetic',
      ConditionExpression: '#data = :existing',
      ExpressionAttributeValues: { ':existing': stored },
    });
  });

  it('does not write already clean metadata', async () => {
    const { repository: identity, send } = repository({ data: metadata });
    await identity.ensureDemoPublisher('a');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still refuses to overwrite unrelated publisher changes', async () => {
    const { repository: identity, send } = repository({ data: { ...metadata, name: 'Changed', demoData: true } });
    await expect(identity.ensureDemoPublisher('a')).rejects.toThrow('BOOTSTRAP_CONFLICT');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed conditional update instead of retrying an overwrite', async () => {
    const { repository: identity, send } = repository({ data: { ...metadata, demoData: true } });
    send.mockReset().mockResolvedValueOnce({ Item: { data: { ...metadata, demoData: true } } })
      .mockRejectedValueOnce(new Error('ConditionalCheckFailedException'));

    await expect(identity.ensureDemoPublisher('a')).rejects.toThrow('ConditionalCheckFailedException');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
