export class CustomerDto {
  full_name: string;
  first_name: string;
  email: string;
  mobile?: string;
  CPF?: string;
  ip?: string;
  instagram?: string;
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  zipcode?: string;
}

export class KiwifyWebhookDto {
  order_id: string;
  order_ref: string;
  order_status: string;
  product_type?: string;
  payment_method?: string;
  store_id?: string;
  payment_merchant_id?: number;
  installments?: number;
  card_type?: string;
  card_last4digits?: string;
  card_rejection_reason?: string | null;
  boleto_URL?: string | null;
  boleto_barcode?: string | null;
  boleto_expiry_date?: string | null;
  pix_code?: string | null;
  pix_expiration?: string | null;
  sale_type?: string;
  created_at?: string;
  updated_at?: string;
  approved_date?: string;
  refunded_at?: string | null;
  webhook_event_type: string;
  Product?: {
    product_id: string;
    product_name: string;
  };
  Customer: CustomerDto;
  Commissions?: any;
  TrackingParameters?: any;
  Subscription?: any;
  subscription_id?: string;
  access_url?: string | null;
}

