-- Fictional local demo fixture. No real customer or order data.
CREATE TABLE public.customers (
    id bigint PRIMARY KEY,
    display_name text NOT NULL
);
CREATE TABLE public.orders (
    id bigint PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES public.customers(id),
    total_amount numeric(12,2) NOT NULL DEFAULT 0,
    currency character(3) NOT NULL DEFAULT 'USD',
    status text NOT NULL DEFAULT 'pending',
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
INSERT INTO public.customers (id, display_name) VALUES
    (1, 'Demo Customer A'), (2, 'Demo Customer B'),
    (3, 'Demo Customer C'), (4, 'Demo Customer D'),
    (5, 'Demo Customer E'), (6, 'Demo Customer F');
INSERT INTO public.orders VALUES
    (1001, 1, 125.00, 'USD', 'paid', '2026-10-01 10:00:00+00'),
    (1002, 2, 80.00, 'USD', 'paid', '2026-10-02 10:00:00+00'),
    (1003, 3, 65.00, 'USD', 'pending', '2026-10-03 10:00:00+00'),
    (1004, 4, 210.00, 'USD', 'shipped', '2026-10-04 10:00:00+00'),
    (1005, 5, 45.00, 'USD', 'paid', '2026-10-05 10:00:00+00'),
    (1006, 6, 90.00, 'USD', 'cancelled', '2026-10-06 10:00:00+00'),
    (1007, 1, 150.00, 'USD', 'shipped', '2026-10-07 10:00:00+00'),
    (1008, 2, 120.00, 'USD', 'paid', '2026-10-08 10:00:00+00'),
    (1009, 3, 55.00, 'USD', 'pending', '2026-10-09 10:00:00+00'),
    (1010, 4, 190.00, 'USD', 'paid', '2026-10-10 10:00:00+00'),
    (1011, 5, 60.00, 'USD', 'shipped', '2026-10-11 10:00:00+00'),
    (1012, 6, 75.00, 'USD', 'paid', '2026-10-12 10:00:00+00'),
    (1013, 1, 40.00, 'USD', 'cancelled', '2026-10-13 10:00:00+00'),
    (1014, 2, 110.00, 'USD', 'paid', '2026-10-14 10:00:00+00'),
    (1015, 3, 85.00, 'USD', 'pending', '2026-10-15 10:00:00+00'),
    (1016, 4, 95.00, 'USD', 'shipped', '2026-10-16 10:00:00+00'),
    (1017, 5, 130.00, 'USD', 'paid', '2026-10-17 10:00:00+00'),
    (1018, 6, 70.00, 'USD', 'paid', '2026-10-18 10:00:00+00'),
    (1019, 1, 160.00, 'USD', 'shipped', '2026-10-19 10:00:00+00'),
    (1020, 2, 105.00, 'USD', 'paid', '2026-10-20 10:00:00+00');
