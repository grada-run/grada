import { describe, it, expect, vi } from 'vitest';
import {
    discoverEligibleRevisions,
    createEcsRevisionAdapter,
    filterEligibleRevisions,
    pickNewestEligible,
    INTERACTIVE_CANDIDATE_LIMIT,
} from '../src/utils/revision-discovery.js';

const arn = (rev) => `arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:${rev}`;

describe('revision-discovery seam', () => {
    it('filters revisions older than the deployed one, newest first', () => {
        expect(filterEligibleRevisions([arn(5), arn(4), arn(3)], 4)).toEqual([arn(3)]);
        expect(filterEligibleRevisions([arn(2)], 2)).toEqual([]);
    });

    it('discovers through a generic adapter', async () => {
        const adapter = {
            listRevisionArns: vi.fn(async () => [arn(5), arn(4), arn(3)]),
        };
        await expect(discoverEligibleRevisions(adapter, 'myapp-task', 4)).resolves.toEqual([arn(3)]);
        expect(adapter.listRevisionArns).toHaveBeenCalledWith('myapp-task');
    });

    it('ecs adapter lists ACTIVE revisions newest first', async () => {
        const send = vi.fn(async () => ({ taskDefinitionArns: [arn(2)] }));
        const adapter = createEcsRevisionAdapter({ send });
        await expect(discoverEligibleRevisions(adapter, 'myapp-task', 2)).resolves.toEqual([]);
        expect(send).toHaveBeenCalledTimes(1);
        const command = send.mock.calls[0][0];
        expect(command.constructor.name).toBe('ListTaskDefinitionsCommand');
        expect(command.input).toMatchObject({ familyPrefix: 'myapp-task', status: 'ACTIVE', sort: 'DESC' });
    });

    it('headless picks the newest eligible revision', () => {
        expect(pickNewestEligible([arn(4), arn(3)])).toBe(arn(4));
        expect(pickNewestEligible([])).toBeNull();
    });

    it('interactive candidates cap at five', () => {
        expect(INTERACTIVE_CANDIDATE_LIMIT).toBe(5);
    });
});
