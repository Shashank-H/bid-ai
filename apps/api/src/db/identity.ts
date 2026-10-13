import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PublisherMembershipSchema, UserSchema } from '@bid/shared';
import type { PublisherMembership, User } from '@bid/shared';
import type { UserRepository } from '../domain/interfaces.js';
import { isDeepStrictEqual } from 'node:util';

export class IdentityRepository implements UserRepository {
  private readonly document: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly publisherTable: string;

  constructor(client: DynamoDBClient, prefix: string) {
    this.document = DynamoDBDocumentClient.from(client);
    this.table = `${prefix}-identity`;
    this.publisherTable = `${prefix}-publisher-data`;
  }

  async findById(userId: string): Promise<User | null> {
    const result = await this.document.send(new GetCommand({ TableName: this.table,
      Key: { PK: `USER#${userId}`, SK: 'USER' }, ConsistentRead: true }));

    return result.Item ? UserSchema.parse(result.Item['data']) : null;
  }

  async findByLogin(login: string): Promise<User | null> {
    const result = await this.document.send(new GetCommand({ TableName: this.table,
      Key: { PK: `LOGIN#${login}`, SK: 'USER' }, ConsistentRead: true }));

    return typeof result.Item?.['userId'] === 'string' ? this.findById(result.Item['userId']) : null;
  }

  async memberships(userId: string): Promise<readonly PublisherMembership[]> {
    const result = await this.document.send(new QueryCommand({ TableName: this.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'MEMBERSHIP#' }, ConsistentRead: true }));

    return (result.Items ?? []).map((item) => PublisherMembershipSchema.parse(item['data']));
  }

  async ensureDemoPublisher(letter: 'a' | 'b'): Promise<void> {
    const publisherId = `publisher-${letter}`;
    const Key = { PK: `PUBLISHER#${publisherId}`, SK: 'METADATA' };
    const data = { publisherId, name: `Publisher ${letter.toUpperCase()}`, currency: 'USD', demoData: true };
    const existing = await this.document.send(new GetCommand({ TableName: this.publisherTable, Key, ConsistentRead: true }));

    if (existing.Item) {
      if (!isDeepStrictEqual(existing.Item['data'], data)) throw new Error('BOOTSTRAP_CONFLICT: existing publisher was not replaced');
      return;
    }

    await this.document.send(new PutCommand({ TableName: this.publisherTable, Item: { ...Key, data },
      ConditionExpression: 'attribute_not_exists(PK)' }));
  }

  async createUser(user: User, membership: PublisherMembership): Promise<void> {
    UserSchema.parse(user);
    PublisherMembershipSchema.parse(membership);

    if (user.userId !== membership.userId) throw new Error('INVALID_INPUT');

    await this.document.send(new TransactWriteCommand({ TransactItems: [
      { PK: `USER#${user.userId}`, SK: 'USER', data: user },
      { PK: `LOGIN#${user.login}`, SK: 'USER', userId: user.userId },
      { PK: `USER#${user.userId}`, SK: `MEMBERSHIP#${membership.publisherId}`, data: membership },
    ].map((Item) => ({ Put: { TableName: this.table, Item, ConditionExpression: 'attribute_not_exists(PK)' } })) }));
  }
}
