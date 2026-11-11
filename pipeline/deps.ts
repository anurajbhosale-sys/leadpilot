// Production wiring for the pipeline: the app database plus the (mock) CRM and ad platforms.
import { db } from "@/db";
import { MockAdSpend } from "@/lib/providers/adspend";
import { MockCrmExport } from "@/lib/providers/crm-export";
import { defaultFailureRate } from "@/lib/providers/faults";
import { runPipeline, type PipelineDeps } from "./run";
import {
  adSpendSource,
  appCallsSource,
  appLeadsSource,
  branchList,
  crmCustomersSource,
  crmSubscriptionsSource,
} from "./sources";

export async function defaultPipelineDeps(log?: (message: string) => void): Promise<PipelineDeps> {
  // Mocks fail now and then and rate-limit like real APIs, so retries get exercised.
  const faults = { failureRate: defaultFailureRate(), maxRequestsPerSecond: 10 };
  const crm = new MockCrmExport(db, { faults });
  const adspend = new MockAdSpend({ branches: await branchList(db), faults });
  return {
    db,
    crm,
    sources: [
      appLeadsSource(db),
      appCallsSource(db),
      crmCustomersSource(crm),
      crmSubscriptionsSource(crm),
      adSpendSource(adspend),
    ],
    log,
  };
}

export async function runPipelineJob(log?: (message: string) => void) {
  return runPipeline(await defaultPipelineDeps(log));
}
