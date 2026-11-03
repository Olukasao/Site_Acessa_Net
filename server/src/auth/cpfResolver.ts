import type { ContractSummary } from "../types.js";
import type { SgpUraClient } from "../integrations/sgp/sgpClient.js";
import type { CustomerRecord, InMemoryStore } from "../repositories/inMemoryStore.js";
import { getDocumentType, normalizeDocument } from "./cpf.js";
import { mapSgpCustomer } from "../integrations/sgp/sgpMapper.js";

export interface CpfResolverResult {
  customer: CustomerRecord;
  contracts: ContractSummary[];
}

/** Resolve CPF/CNPJ -> cliente/contratos consultando o SGP, cacheando o resultado no InMemoryStore (customers/contracts). */
export class CpfResolver {
  constructor(
    private readonly store: InMemoryStore,
    private readonly client: SgpUraClient,
    /** Segredo p/ derivar o customerId por HMAC (so quando CUSTOMER_ID_HMAC=1; vazio = id legado). */
    private readonly customerIdSecret?: string
  ) {}

  async resolve(documento: string): Promise<CpfResolverResult | null> {
    const digits = normalizeDocument(documento);
    if (!getDocumentType(digits)) {
      return null;
    }

    const contracts = await this.client.consultCustomerByDocument(digits);
    if (contracts.length === 0) {
      return null;
    }

    const mapped = mapSgpCustomer(digits, contracts, { hmacSecret: this.customerIdSecret });
    if (!mapped) {
      return null;
    }

    const customer = this.store.upsertCustomer(mapped.customer);
    for (const contract of mapped.contracts) {
      this.store.upsertContract(contract);
    }

    return { customer, contracts: mapped.contracts };
  }
}
